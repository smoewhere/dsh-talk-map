/** rc.5 JSONL adapter. Never derives a deletion target from a session's cwd. */
import { randomUUID, createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  readFile,
  rmdir,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute, basename } from 'node:path'
import { z } from 'zod'
import type { TrashEntry, TrashResult } from '../shared/trash.ts'
import type { Domain, KvTable } from './dsh-host.ts'
import { cardSchema, edgeSchema, digestSchema, type TalkMapStore } from './store.ts'

export const safeId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/)
  .refine((id) => id !== '.' && id !== '..')
const entryId = z.string().uuid()
const headerSchema = z
  .object({
    id: safeId,
    version: z.literal(4),
    createdAt: z.number(),
    cwd: z.string().optional(),
    parentSession: z.string().optional(),
    origin: z.literal('subagent').optional(),
    isSeeded: z.boolean(),
  })
  .passthrough()
type Header = z.infer<typeof headerSchema>
interface Workspace {
  id: string
  path: string
  title: string
  sessionIds: readonly string[]
  attachSession(id: string): Promise<void>
  detachSession(id: string): Promise<void>
  insertSessionBefore(id: string, before?: string): Promise<void>
}
export interface TrashServices {
  sessionPersistence: {
    root: string
    locate(header: Header): { kind: string; path: string }
    list(): Promise<{ header: unknown; formatStatus?: string }[]>
    stat(id: string): Promise<{ header: unknown; formatStatus?: string } | undefined>
    open(id: string, access: 'write'): Promise<{ close(): Promise<void> }>
    acquireLease(id: string, cwd: undefined, dir: string): Promise<{ release(): Promise<void> }>
  }
  sessions: { get(id: string): unknown }
  agents: { get(id: string): { status?: string } | undefined }
  storageDomain: { get(name: string): Domain | undefined }
  sessionProjectionCache: {
    cachedSnapshot(header: Header): { asOfSeq: number; values: Record<string, unknown> } | undefined
  }
  workspaceRegistry: {
    list(): Workspace[]
    get(id: string): Workspace | undefined
    create(path: string, title?: string): Promise<Workspace>
    readonly archivedSessionIds: readonly string[]
    readonly pinnedSessionIds: readonly string[]
    unarchiveSession(id: string): Promise<void>
    unpinSession(id: string): Promise<void>
    archiveSession(id: string): Promise<void>
    pinSession(id: string): Promise<void>
  }
  waterfall(
    event: 'workspace/session-activity',
    request: { sessionId: string },
    next: () => Promise<unknown[]>,
  ): Promise<unknown[]>
  emit(event: string, ...args: unknown[]): void
  logger?: { warn(message: string): void }
}
const fileSchema = z.object({
  sessionId: safeId,
  source: z.string(),
  name: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
})
const manifestSchema = z
  .object({
    version: z.literal(1),
    entryId,
    sessionId: safeId,
    title: z.string(),
    deletedAt: z.number(),
    state: z.enum(['staging', 'trashed', 'restoring', 'restored', 'purging', 'purged', 'failed']),
    operation: z.enum(['trash', 'restore', 'purge']),
    error: z.string().optional(),
    headers: z.array(headerSchema).min(1),
    files: z.array(fileSchema).min(1),
    memberships: z.array(
      z.object({
        sessionId: safeId,
        workspaceId: z.string(),
        path: z.string(),
        title: z.string(),
        before: z.string().optional(),
      }),
    ),
    archived: z.array(safeId),
    pinned: z.array(safeId),
    cache: z.record(z.string(), z.unknown()),
    map: z.object({
      cards: z.record(z.string(), cardSchema),
      edges: z.record(z.string(), edgeSchema),
      digests: z.record(z.string(), digestSchema),
      memory: z.record(
        z.string(),
        z.object({ x: z.number(), y: z.number(), colorTag: z.string().optional() }),
      ),
    }),
  })
  .refine((m) => {
    const ids = new Set(m.headers.map((h) => h.id))
    return (
      ids.size === m.headers.length &&
      ids.has(m.sessionId) &&
      m.files.every((f) => ids.has(f.sessionId)) &&
      m.memberships.every((w) => ids.has(w.sessionId)) &&
      [
        ...m.archived,
        ...m.pinned,
        ...Object.keys(m.cache),
        ...Object.keys(m.map.memory),
        ...Object.keys(m.map.digests),
      ].every((id) => ids.has(id)) &&
      Object.values(m.map.cards).every((c) => ids.has(c.sessionId)) &&
      Object.values(m.map.edges).every(
        (e) => m.map.cards[e.fromCardId] !== undefined || m.map.cards[e.toCardId] !== undefined,
      )
    )
  }, 'manifest ownership mismatch')
type Manifest = z.infer<typeof manifestSchema>
const LOG_NAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/
class TrashError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
function fail(code: string, message: string): never {
  throw new TrashError(code, message)
}
const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}
const hash = async (path: string): Promise<string> => {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex')
}

/** All mutations share a chain, including writes that could resurrect deleted cards. */
export class SessionTrash {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly blocked = new Set<string>()
  private readonly entries = new Map<string, Manifest>()
  private readonly purged = new Set<string>()
  private root = ''
  private sessionsRoot = ''
  private ready = false
  constructor(
    private readonly services: TrashServices,
    private readonly store: TalkMapStore,
    private readonly home: string,
  ) {}
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.chain.then(operation)
    this.chain = task.catch(() => undefined)
    return task
  }
  isBlocked(id: string): boolean {
    return this.blocked.has(id) || this.purged.has(id)
  }
  async close(): Promise<void> {
    await this.serial(async () => {
      this.ready = false
    })
  }
  async writeActive<T>(ids: readonly string[], operation: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      this.requireReady()
      if (ids.some((id) => this.isBlocked(id))) fail('SESSION_TRASHED', '会话已移入回收站')
      return operation()
    })
  }
  private requireReady(): void {
    if (!this.ready) fail('SERVICE_UNAVAILABLE', '回收站正在初始化或恢复')
  }
  private cache(): KvTable<unknown> {
    const domain = this.services.storageDomain.get('session_projcache')
    if (!domain) return fail('SERVICE_UNAVAILABLE', '会话缓存服务不可用')
    return domain.table('sessions')
  }
  private async inside(root: string, target: string, missing = false): Promise<string> {
    // Check every ancestor, including nonexistent destinations and Windows junctions.
    const abs = resolve(target)
    const rel = relative(root, abs)
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../'))
      fail('PATH_UNSAFE', '会话文件路径不安全')
    let cursor = root
    for (const part of rel.split(/[\\/]/)) {
      cursor = join(cursor, part)
      try {
        const info = await lstat(cursor)
        if (info.isSymbolicLink()) fail('PATH_UNSAFE', '会话文件不能通过符号链接访问')
        const actual = await realpath(cursor)
        const r = relative(root, actual)
        if (isAbsolute(r) || r === '..' || r.startsWith('..\\') || r.startsWith('../'))
          fail('PATH_UNSAFE', '会话文件超出允许目录')
      } catch (e) {
        if (missing && (e as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw e
      }
    }
    return abs
  }
  private entryDir(id: string): string {
    return join(this.root, entryId.parse(id))
  }
  private async pruneUnstarted(dir: string): Promise<void> {
    const names = await readdir(dir)
    if (names.some((name) => name !== 'manifest.tmp')) fail('PATH_UNSAFE', '回收站条目缺少操作清单')
    if (names.includes('manifest.tmp')) {
      const temp = await this.inside(this.root, join(dir, 'manifest.tmp'))
      if (!(await lstat(temp)).isFile()) fail('PATH_UNSAFE', '回收站临时清单不是普通文件')
      await unlink(temp)
    }
    await rmdir(dir)
  }
  private async save(m: Manifest): Promise<void> {
    const dir = await this.inside(this.root, this.entryDir(m.entryId))
    const target = await this.inside(this.root, join(dir, 'manifest.json'), true)
    const temp = await this.inside(this.root, join(dir, 'manifest.tmp'), true)
    const fd = await open(temp, 'w', 0o600)
    try {
      await fd.writeFile(JSON.stringify(m))
      await fd.sync()
    } finally {
      await fd.close()
    }
    await rename(temp, target)
    this.entries.set(m.entryId, m)
  }
  private async source(f: Manifest['files'][number], m: Manifest): Promise<string> {
    const h = m.headers.find((h) => h.id === f.sessionId)
    if (!h || !LOG_NAME.test(f.name) || basename(f.name) !== f.name)
      return fail('PATH_UNSAFE', '回收站文件清单无效')
    const located = this.services.sessionPersistence.locate(h)
    if (located.kind !== 'jsonl') fail('SERVICE_UNAVAILABLE', '当前持久化格式暂不支持回收站')
    const target = await this.inside(this.sessionsRoot, join(this.sessionsRoot, f.source), true)
    if (dirname(target) !== resolve(dirname(located.path)) || basename(target) !== f.name)
      fail('PATH_UNSAFE', '日志文件与会话身份不匹配')
    return target
  }
  private async saved(f: Manifest['files'][number], m: Manifest): Promise<string> {
    return this.inside(this.root, join(this.entryDir(m.entryId), 'logs', f.sessionId, f.name), true)
  }
  private async move(from: string, to: string, expected: string): Promise<void> {
    if (await exists(to)) fail('RESTORE_CONFLICT', '目标文件已存在')
    if (!(await lstat(from)).isFile() || (await hash(from)) !== expected)
      fail('FILE_CHANGED', '会话文件在操作期间发生变化')
    await mkdir(dirname(to), { recursive: true })
    // Exclusive copy keeps recovery deterministic even when interrupted between copy and unlink.
    await copyFile(from, to, constants.COPYFILE_EXCL)
    const fd = await open(to, 'r+')
    try {
      await fd.sync()
    } finally {
      await fd.close()
    }
    if ((await hash(to)) !== expected || (await hash(from)) !== expected)
      fail('FILE_CHANGED', '会话文件校验失败')
    await unlink(from)
  }
  private async verifyLog(path: string, id: string): Promise<void> {
    const source = createReadStream(path, { highWaterMark: 4096 })
    const stream = path.endsWith('.zstd') ? source.pipe(createZstdDecompress()) : source
    if (stream !== source) source.on('error', (error) => stream.destroy(error))
    let first = Buffer.alloc(0)
    try {
      for await (const bytes of stream) {
        first = Buffer.concat([first, Buffer.from(bytes)])
        const end = first.indexOf(10)
        if (end >= 0) {
          let header: unknown
          try {
            header = JSON.parse(first.subarray(0, end).toString('utf8'))
          } catch {
            fail('PATH_UNSAFE', '日志头无法验证')
          }
          if (
            typeof header !== 'object' ||
            header === null ||
            (header as { id?: unknown }).id !== id
          )
            fail('PATH_UNSAFE', '日志不属于目标会话')
          return
        }
        if (first.length > 1024 * 1024) fail('PATH_UNSAFE', '日志头过大，无法验证')
      }
      fail('PATH_UNSAFE', '会话日志缺少可验证的文件头')
    } finally {
      stream.destroy()
      source.destroy()
    }
  }
  private async ensureAvailable(headers: Header[]): Promise<void> {
    for (const h of headers) {
      if (
        this.services.agents.get(h.id)?.status === 'running' ||
        (
          await this.services.waterfall(
            'workspace/session-activity',
            { sessionId: h.id },
            async () => [],
          )
        ).length
      )
        fail('SESSION_RUNNING', '会话或子代理仍有运行中的任务')
      if (this.services.sessions.get(h.id) || this.services.agents.get(h.id))
        fail('SESSION_IN_USE', '会话仍被占用，请重启 DSH 后再删除')
    }
  }
  async initialize(): Promise<void> {
    const persistence = this.services.sessionPersistence
    if (
      typeof persistence.locate !== 'function' ||
      typeof persistence.acquireLease !== 'function' ||
      typeof persistence.open !== 'function'
    )
      fail('SERVICE_UNAVAILABLE', '当前持久化服务不支持安全回收站')
    const home = await realpath(this.home)
    this.sessionsRoot = await realpath(join(home, 'sessions'))
    if ((await realpath(persistence.root)) !== this.sessionsRoot)
      fail('SERVICE_UNAVAILABLE', '当前会话根目录暂不支持回收站')
    const trash = await this.inside(home, join(home, 'talk-map-trash'), true)
    await mkdir(trash, { recursive: true, mode: 0o700 })
    this.root = await this.inside(home, join(trash, 'entries'), true)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    this.cache()
    const purgedPath = await this.inside(home, join(trash, 'purged.json'), true)
    if (await exists(purgedPath))
      for (const id of z.array(safeId).parse(JSON.parse(await readFile(purgedPath, 'utf8'))))
        this.purged.add(id)
    for (const item of await readdir(this.root, { withFileTypes: true })) {
      if (!item.isDirectory() || !entryId.safeParse(item.name).success)
        fail('PATH_UNSAFE', '回收站目录包含无法识别的条目')
      if ((await readdir(await this.inside(this.root, join(this.root, item.name)))).length === 0) {
        await rmdir(join(this.root, item.name))
        continue
      }
      const manifestPath = join(this.root, item.name, 'manifest.json')
      if (!(await exists(manifestPath))) {
        await this.pruneUnstarted(await this.inside(this.root, join(this.root, item.name)))
        continue
      }
      const path = await this.inside(this.root, manifestPath)
      const m = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      if (m.entryId !== item.name || !m.headers.some((h) => h.id === m.sessionId))
        fail('PATH_UNSAFE', '回收站条目身份不匹配')
      for (const f of m.files) {
        await this.source(f, m)
        await this.saved(f, m)
      }
      this.entries.set(m.entryId, m)
      if (!['restored', 'purged'].includes(m.state))
        m.headers.forEach((h) => this.blocked.add(h.id))
    }
    for (const m of this.entries.values()) {
      if (m.state === 'restored') {
        await this.discardEntry(m)
        continue
      }
      if (['staging', 'restoring', 'purging', 'failed'].includes(m.state)) {
        try {
          await this.recover(m)
        } catch (e) {
          m.state = 'failed'
          m.error = String(e)
          await this.save(m)
        }
      }
    }
    this.ready = true
  }
  list(): TrashEntry[] {
    this.requireReady()
    return [...this.entries.values()]
      .filter((m) => !['restored', 'purged'].includes(m.state))
      .map((m) => ({
        entryId: m.entryId,
        sessionId: m.sessionId,
        title: m.title,
        sessionCount: m.headers.length,
        workspace: m.memberships[0]?.title ?? '',
        deletedAt: m.deletedAt,
        state: m.state,
        error: m.error ? '操作未完成，请重启 DSH 后重试' : undefined,
      }))
      .sort((a, b) => b.deletedAt - a.deletedAt)
  }
  private result(
    requestId: string,
    m: Manifest | undefined,
    status: TrashResult['status'],
    error?: unknown,
  ): TrashResult {
    if (error) this.services.logger?.warn(`[talk-map] ${requestId}: ${String(error)}`)
    const locked = (error as Error)?.name === 'SessionAlreadyOwnedError'
    return {
      requestId,
      sessionId: m?.sessionId ?? (safeId.safeParse(requestId).success ? requestId : undefined),
      entryId: m?.entryId,
      affectedSessionIds: status === 'failed' ? [] : (m?.headers.map((h) => h.id) ?? []),
      status,
      ...(error
        ? {
            error: {
              code:
                error instanceof TrashError
                  ? error.code
                  : locked
                    ? 'SESSION_IN_USE'
                    : 'INTERNAL_ERROR',
              message:
                error instanceof TrashError
                  ? error.message
                  : locked
                    ? '会话文件仍被占用，请稍后重试'
                    : '操作失败，数据已保留或等待恢复，请重试',
            },
          }
        : {}),
    }
  }
  async trash(ids: readonly string[]): Promise<TrashResult[]> {
    return this.serial(async () => {
      this.requireReady()
      const results: TrashResult[] = []
      const ordered = [...new Set(ids)]
      try {
        const headers = new Map(
          (await this.services.sessionPersistence.list()).map((r) => {
            const h = r.header as Header
            return [h.id, h] as const
          }),
        )
        const depth = (id: string): number => {
          const seen = new Set<string>()
          let current = headers.get(id)
          while (current?.origin === 'subagent' && current.parentSession && !seen.has(current.id)) {
            seen.add(current.id)
            current = headers.get(current.parentSession)
          }
          return seen.size
        }
        ordered.sort((a, b) => depth(a) - depth(b))
      } catch {
        /* Each item below reports its own listing failure. */
      }
      for (const id of ordered) {
        let m: Manifest | undefined
        let journaled = false
        const handles: { close(): Promise<void> }[] = []
        try {
          safeId.parse(id)
          const previous = [...this.entries.values()].find(
            (m) => m.headers.some((h) => h.id === id) && m.state === 'trashed',
          )
          if (previous) {
            results.push(this.result(id, previous, 'trashed'))
            continue
          }
          if (this.isBlocked(id)) fail('SESSION_IN_USE', '此会话有未完成的回收站操作')
          const records = await this.services.sessionPersistence.list()
          const root = records.find((r) => (r.header as Header).id === id)
          if (!root) fail('SESSION_NOT_FOUND', '会话不存在')
          const headers = [headerSchema.parse(root.header)]
          for (let i = 0; i < headers.length; i++)
            for (const r of records) {
              const h = r.header as Header
              if (
                h.origin === 'subagent' &&
                h.parentSession === headers[i].id &&
                !headers.some((x) => x.id === h.id)
              )
                headers.push(headerSchema.parse(h))
            }
          if (
            headers.some(
              (h) =>
                records.find((r) => (r.header as Header).id === h.id)?.formatStatus &&
                records.find((r) => (r.header as Header).id === h.id)?.formatStatus !== 'current',
            )
          )
            fail('UNSUPPORTED_SESSION_FORMAT', '请先通过 DSH 升级此会话格式')
          await this.ensureAvailable(headers)
          for (const h of headers)
            await this.inside(this.sessionsRoot, this.services.sessionPersistence.locate(h).path)
          for (const h of [...headers].sort((a, b) => a.id.localeCompare(b.id)))
            handles.push(await this.services.sessionPersistence.open(h.id, 'write'))
          await this.ensureAvailable(headers)
          const wanted = new Set(headers.map((h) => h.id))
          const files: Manifest['files'] = []
          for (const h of headers) {
            const location = this.services.sessionPersistence.locate(h)
            if (location.kind !== 'jsonl') fail('SERVICE_UNAVAILABLE', '当前存储格式不支持回收站')
            const path = await this.inside(this.sessionsRoot, location.path)
            for (const item of await readdir(dirname(path), { withFileTypes: true })) {
              if (!LOG_NAME.test(item.name)) continue
              const source = await this.inside(this.sessionsRoot, join(dirname(path), item.name))
              if (!item.isFile()) fail('PATH_UNSAFE', '会话日志不是普通文件')
              await this.verifyLog(source, h.id)
              files.push({
                sessionId: h.id,
                source: relative(this.sessionsRoot, source),
                name: item.name,
                hash: await hash(source),
              })
            }
          }
          if (files.length === 0 || headers.some((h) => !files.some((f) => f.sessionId === h.id)))
            fail('SESSION_NOT_FOUND', '找不到完整的会话日志')
          const cards = Object.fromEntries(
            [...this.store.cards.entries()].filter(([, c]) => wanted.has(c.sessionId)),
          )
          const cardIds = new Set(Object.keys(cards))
          const global = this.store.global()
          m = {
            version: 1,
            entryId: randomUUID(),
            sessionId: id,
            title: this.title(headers[0]),
            deletedAt: Date.now(),
            state: 'staging',
            operation: 'trash',
            headers,
            files,
            memberships: this.services.workspaceRegistry.list().flatMap((w) =>
              w.sessionIds
                .filter((s) => wanted.has(s))
                .map((s) => ({
                  sessionId: s,
                  workspaceId: w.id,
                  path: w.path,
                  title: w.title,
                  before: w.sessionIds[w.sessionIds.indexOf(s) + 1],
                })),
            ),
            archived: this.services.workspaceRegistry.archivedSessionIds.filter((s) =>
              wanted.has(s),
            ),
            pinned: this.services.workspaceRegistry.pinnedSessionIds.filter((s) => wanted.has(s)),
            cache: Object.fromEntries(
              headers.flatMap((h) => {
                const v = this.cache().get(h.id)
                return v === undefined ? [] : [[h.id, v]]
              }),
            ),
            map: {
              cards,
              edges: Object.fromEntries(
                [...this.store.edges.entries()].filter(
                  ([, e]) => cardIds.has(e.fromCardId) || cardIds.has(e.toCardId),
                ),
              ),
              digests: Object.fromEntries(
                [...this.store.digests.entries()].filter(([s]) => wanted.has(s)),
              ),
              memory: Object.fromEntries(
                Object.entries(global.layoutMemory ?? {}).filter(([s]) => wanted.has(s)),
              ),
            },
          }
          m = manifestSchema.parse(m)
          await mkdir(await this.inside(this.root, this.entryDir(m.entryId), true), { mode: 0o700 })
          await this.save(m)
          journaled = true
          headers.forEach((h) => this.blocked.add(h.id))
          for (const f of files)
            await this.move(await this.source(f, m), await this.saved(f, m), f.hash)
          await this.removeMetadata(m)
          m.state = 'trashed'
          await this.save(m)
          for (const h of headers) this.publish('api-session/removed', h.id)
          results.push(this.result(id, m, 'trashed'))
        } catch (error) {
          if (m && journaled) {
            try {
              await this.recover(m, true)
            } catch (rollback) {
              m.state = 'failed'
              m.error = String(rollback)
              await this.save(m)
            }
          }
          if (m && !journaled && (await exists(this.entryDir(m.entryId)))) {
            try {
              await this.pruneUnstarted(await this.inside(this.root, this.entryDir(m.entryId)))
            } catch (cleanup) {
              this.services.logger?.warn(`[talk-map] unstarted entry: ${String(cleanup)}`)
            }
          }
          results.push(this.result(id, m, 'failed', error))
        } finally {
          for (const h of handles.reverse()) await h.close()
        }
      }
      return results
    })
  }
  private title(h: Header): string {
    const value = this.services.sessionProjectionCache.cachedSnapshot(h)?.values.title
    return typeof value === 'string' && value ? value : h.id
  }
  private async removeMetadata(m: Manifest): Promise<void> {
    for (const h of m.headers) {
      for (const w of this.services.workspaceRegistry.list())
        if (w.sessionIds.includes(h.id)) await w.detachSession(h.id)
      await this.services.workspaceRegistry.unpinSession(h.id)
      await this.services.workspaceRegistry.unarchiveSession(h.id)
      await this.cache().delete(h.id)
      await this.store.digests.delete(h.id)
    }
    for (const id of Object.keys(m.map.edges)) await this.store.edges.delete(id)
    for (const id of Object.keys(m.map.cards)) await this.store.cards.delete(id)
    const global = this.store.global()
    const memory = { ...global.layoutMemory }
    for (const h of m.headers) delete memory[h.id]
    await this.store.setGlobal({ ...global, layoutMemory: memory })
  }
  private async restoreMetadata(m: Manifest): Promise<void> {
    for (const [id, value] of Object.entries(m.cache)) await this.cache().put(id, value)
    for (const membership of [...m.memberships].reverse()) {
      let w = this.services.workspaceRegistry.get(membership.workspaceId)
      if (w && w.path !== membership.path) fail('RESTORE_CONFLICT', '工作区身份发生变化')
      w ??= await this.services.workspaceRegistry.create(membership.path, membership.title)
      await w.attachSession(membership.sessionId)
      if (membership.before && w.sessionIds.includes(membership.before))
        await w.insertSessionBefore(membership.sessionId, membership.before)
    }
    for (const id of m.archived) await this.services.workspaceRegistry.archiveSession(id)
    for (const id of [...m.pinned].reverse()) await this.services.workspaceRegistry.pinSession(id)
    for (const [id, c] of Object.entries(m.map.cards))
      if (!this.store.cards.get(id)) await this.store.cards.put(id, c as never)
    for (const [id, e] of Object.entries(m.map.edges)) {
      const edge = e as { fromCardId: string; toCardId: string }
      if (
        !this.store.edges.get(id) &&
        this.store.cards.get(edge.fromCardId) &&
        this.store.cards.get(edge.toCardId)
      )
        await this.store.edges.put(id, e as never)
    }
    for (const [id, d] of Object.entries(m.map.digests))
      if (!this.store.digests.get(id)) await this.store.digests.put(id, d as never)
    const global = this.store.global()
    await this.store.setGlobal({
      ...global,
      layoutMemory: { ...m.map.memory, ...global.layoutMemory } as never,
    })
  }
  private publishAdded(m: Manifest): void {
    for (const h of m.headers) {
      const block = this.services.sessionProjectionCache.cachedSnapshot(h)
      const meta = block?.values.sessionListMetadata as
        { blank?: boolean; lastPromptAt?: number } | undefined
      this.publish('api-session/added', {
        sessionId: h.id,
        cwd: h.cwd,
        parentSessionId: h.parentSession,
        origin: h.origin,
        formatStatus: 'current',
        agentAvailable: false,
        running: false,
        blank: meta?.blank ?? false,
        updatedAt: Math.max(meta?.lastPromptAt ?? 0, h.createdAt),
        ...(block ? { projections: { kind: 'cached', ...block } } : {}),
      })
    }
  }
  private publish(event: string, ...args: unknown[]): void {
    try {
      this.services.emit(event, ...args)
    } catch (e) {
      this.services.logger?.warn(`[talk-map] notification failed: ${String(e)}`)
    }
  }
  async restore(ids: readonly string[]): Promise<TrashResult[]> {
    return this.entriesOperation(ids, 'restore')
  }
  async purge(ids: readonly string[]): Promise<TrashResult[]> {
    return this.entriesOperation(ids, 'purge')
  }
  private async entriesOperation(
    ids: readonly string[],
    operation: 'restore' | 'purge',
  ): Promise<TrashResult[]> {
    return this.serial(async () => {
      this.requireReady()
      const results: TrashResult[] = []
      for (const id of [...new Set(ids)]) {
        const m = this.entries.get(id)
        const leases: { release(): Promise<void> }[] = []
        try {
          entryId.parse(id)
          if (!m || m.state !== 'trashed') fail('ENTRY_NOT_READY', '条目不存在或需要恢复处理')
          await this.ensureAvailable(m.headers)
          for (const f of m.files) {
            const saved = await this.saved(f, m)
            if (!(await lstat(saved)).isFile() || (await hash(saved)) !== f.hash)
              fail('FILE_CHANGED', '回收站文件校验失败')
            if (await exists(await this.source(f, m)))
              fail('RESTORE_CONFLICT', '原位置已存在会话文件')
          }
          for (const h of [...m.headers].sort((a, b) => a.id.localeCompare(b.id))) {
            if (await this.services.sessionPersistence.stat(h.id))
              fail('RESTORE_CONFLICT', '同 ID 会话已存在')
            const dir = await this.inside(
              this.sessionsRoot,
              dirname(this.services.sessionPersistence.locate(h).path),
              true,
            )
            leases.push(await this.services.sessionPersistence.acquireLease(h.id, undefined, dir))
            await this.inside(this.sessionsRoot, dir)
          }
          if (operation === 'restore') {
            for (const member of m.memberships)
              if (!(await lstat(member.path)).isDirectory())
                fail('RESTORE_CONFLICT', '原工作区目录不可用')
            for (const [cid, card] of Object.entries(m.map.cards))
              if (
                this.store.cards.get(cid) &&
                JSON.stringify(this.store.cards.get(cid)) !== JSON.stringify(card)
              )
                fail('RESTORE_CONFLICT', '地图卡片身份发生变化')
          }
          m.operation = operation
          m.state = operation === 'restore' ? 'restoring' : 'purging'
          delete m.error
          await this.save(m)
          if (operation === 'restore') {
            for (const f of m.files)
              await this.move(await this.saved(f, m), await this.source(f, m), f.hash)
            await this.restoreMetadata(m)
            m.state = 'restored'
            await this.save(m)
            m.headers.forEach((h) => this.blocked.delete(h.id))
            this.publishAdded(m)
            await this.discardEntry(m)
          } else await this.finishPurge(m)
          results.push(this.result(id, m, operation === 'restore' ? 'restored' : 'purged'))
        } catch (error) {
          if (m && ['restoring', 'purging'].includes(m.state))
            try {
              await this.recover(m, true)
            } catch (e) {
              m.state = 'failed'
              m.error = String(e)
              await this.save(m)
            }
          results.push(this.result(id, m, 'failed', error))
        } finally {
          for (const lease of leases.reverse()) await lease.release()
        }
      }
      return results
    })
  }
  private async finishPurge(m: Manifest): Promise<void> {
    for (const f of m.files) {
      const saved = await this.saved(f, m)
      if (await exists(saved)) {
        if (!(await lstat(saved)).isFile() || (await hash(saved)) !== f.hash)
          fail('FILE_CHANGED', '回收站文件校验失败')
        await unlink(saved)
      }
    }
    for (const h of m.headers) this.purged.add(h.id)
    const target = await this.inside(
      await realpath(this.home),
      join(dirname(this.root), 'purged.json'),
      true,
    )
    const temp = await this.inside(
      await realpath(this.home),
      join(dirname(this.root), 'purged.tmp'),
      true,
    )
    const fd = await open(temp, 'w', 0o600)
    try {
      await fd.writeFile(JSON.stringify([...this.purged]))
      await fd.sync()
    } finally {
      await fd.close()
    }
    await rename(temp, target)
    // Keep only IDs as resurrection fences; erase titles, digests and cache snapshots.
    await this.discardEntry(m)
    m.headers.forEach((h) => this.blocked.delete(h.id))
  }
  private async discardEntry(m: Manifest): Promise<void> {
    const manifest = await this.inside(this.root, join(this.entryDir(m.entryId), 'manifest.json'))
    for (const id of new Set(m.files.map((f) => f.sessionId))) {
      const dir = await this.inside(this.root, join(this.entryDir(m.entryId), 'logs', id), true)
      if (await exists(dir)) await rmdir(dir)
    }
    const logs = await this.inside(this.root, join(this.entryDir(m.entryId), 'logs'), true)
    if (await exists(logs)) await rmdir(logs)
    await unlink(manifest)
    await rmdir(this.entryDir(m.entryId))
    this.entries.delete(m.entryId)
  }
  private async recover(m: Manifest, locked = false): Promise<void> {
    const leases: { release(): Promise<void> }[] = []
    try {
      await this.ensureAvailable(m.headers)
      if (!locked)
        for (const h of [...m.headers].sort((a, b) => a.id.localeCompare(b.id))) {
          const dir = await this.inside(
            this.sessionsRoot,
            dirname(this.services.sessionPersistence.locate(h).path),
            true,
          )
          leases.push(await this.services.sessionPersistence.acquireLease(h.id, undefined, dir))
          await this.inside(this.sessionsRoot, dir)
        }
      await this.recoverFiles(m)
    } finally {
      for (const lease of leases.reverse()) await lease.release()
    }
  }
  private async recoverFiles(m: Manifest): Promise<void> {
    if (m.operation === 'purge') {
      await this.ensureAvailable(m.headers)
      await this.finishPurge(m)
      return
    }
    // Roll back an uncommitted trash/restore. Copies left by interruption are hash checked.
    for (const f of m.files) {
      const source = await this.source(f, m),
        saved = await this.saved(f, m)
      const from = m.operation === 'trash' ? saved : source,
        to = m.operation === 'trash' ? source : saved
      if (await exists(from)) {
        if (await exists(to)) {
          if ((await hash(from)) !== f.hash || (await hash(to)) !== f.hash)
            fail('RESTORE_CONFLICT', '恢复文件冲突')
          await unlink(from)
        } else await this.move(from, to, f.hash)
      } else if (!(await exists(to)) || (await hash(to)) !== f.hash)
        fail('FILE_CHANGED', '恢复所需文件缺失')
    }
    if (m.operation === 'trash') {
      await this.restoreMetadata(m)
      m.state = 'restored'
      await this.save(m)
      m.headers.forEach((h) => this.blocked.delete(h.id))
      this.publishAdded(m)
      await this.discardEntry(m)
    } else {
      await this.removeMetadata(m)
      m.state = 'trashed'
      await this.save(m)
    }
  }
}
