import { AsyncLocalStorage } from 'node:async_hooks'

/** rc.5: only the native factory's handle owns the ordered driver/handle teardown. */
type Agent = { id: string; session: { header: { id: string; origin?: string; parentSession?: string }; append: (...args: any[]) => any } }
type Handle = { agent: Agent; dispose(): Promise<void> }
type Callable = Record<string | symbol, any>
export interface LifecycleHost {
  agents: Callable
  agentLoop: Callable
  sessionPersistence: Callable
  sessions: { get(id: string): unknown }
}
const KEY = Symbol.for('dsh-talk-map.session-lifecycle.rc5.v1')
const ERROR = Symbol.for('dsh-talk-map.lifecycle-error.v1')

export class LifecycleError extends Error {
  readonly [ERROR] = true
  constructor(readonly code: string, message: string) { super(message) }
}

/** Kept on the stable registry across plugin reloads, never disposed with the plugin. */
export class SessionLifecycle {
  private readonly internal = new AsyncLocalStorage<{ active: boolean }>()
  private readonly handles = new WeakMap<object, Handle>()
  private readonly pending = new Map<string, Set<Promise<unknown>>>()
  private readonly guarded = new WeakSet<object>()
  private readonly frozen = new Set<string>()
  private readonly draining = new Set<string>()
  private fence: (id: string) => boolean = () => false
  private readonly host: LifecycleHost
  constructor(source: LifecycleHost) {
    // Retain service references, not the plugin's disposable injection context.
    const host = this.host = { agents: source.agents, sessions: source.sessions,
      agentLoop: source.agentLoop, sessionPersistence: source.sessionPersistence }
    const self = this
    const initialize = host.agentLoop.initializeAgent
    // This rc.5 boundary covers ordinary UI sessions, declarative agents and subagents.
    host.agentLoop.initializeAgent = async function (...args: any[]) {
      const session = args[1].session
      const header = session.header
      try {
        self.assertEntry(header.id)
        if (header.origin === 'subagent' && header.parentSession) self.assertEntry(header.parentSession)
      } catch (error) {
        // The factory already handed off a write handle to this boundary. Do not leak it
        // when a create/resume raced with deletion before initialization began.
        await args[1].stored?.handle.close()
        throw error
      }
      if (!self.guarded.has(session)) {
        self.guarded.add(session)
        const append = session.append
        session.append = function (...values: any[]) {
          // An already admitted driver must be able to log its cancellation/results.
          // New input and maintenance are fenced separately; never admit a new turn.
          const completion = ['assistant/attempt', 'assistant/message', 'tool/result', 'step/end', 'turn/end'].includes(values[0])
            || (values[0] === 'agent/inbox/spliced' && Array.isArray(values[1]?.messages) && values[1].messages.length === 0)
          if (!(self.draining.has(header.id) && completion)) self.assertWritable(header.id)
          return Reflect.apply(append, this, values)
        }
      }
      // In-flight setup is allowed to finish; freeze joins it before touching files.
      const task = self.own(async () => {
        const handle: Handle = await Reflect.apply(initialize, this, args)
        for (const name of ['send', 'runMaintenance']) {
          const original = (handle.agent as unknown as Callable)[name]
          if (typeof original !== 'function') continue
          ;(handle.agent as unknown as Callable)[name] = function (...values: any[]) {
            if (self.blocks(handle.agent.id)) throw new LifecycleError('SESSION_TRASHED', '会话正在删除或已移入回收站，请先还原')
            return Reflect.apply(original, this, values)
          }
        }
        self.handles.set(handle.agent, handle)
        return handle
      })
      self.track(header.id, task)
      return task
    }
    for (const name of ['create', 'resume']) {
      const original = host.agents[name]
      host.agents[name] = async function (...args: any[]) {
        const options = args[0] ?? {}
        const id = options.sessionId ?? options.resumeSessionId
        if (id) self.assertEntry(id)
        if (options.parentAgent) self.assertEntry(options.parentAgent.id)
        if (options.meta?.origin === 'subagent' && options.meta.parentSession) self.assertEntry(options.meta.parentSession)
        const task = Reflect.apply(original, this, args)
        if (task instanceof Promise) {
          if (id) self.track(id, task)
          if (options.parentAgent) self.track(options.parentAgent.id, task)
          else if (options.meta?.origin === 'subagent' && options.meta.parentSession) self.track(options.meta.parentSession, task)
        }
        return task
      }
    }
    const create = host.sessionPersistence.create
    if (typeof create === 'function') host.sessionPersistence.create = async function (...args: any[]) {
      const header = args[0]
      self.assertEntry(header.id)
      if (header.origin === 'subagent' && header.parentSession) self.assertEntry(header.parentSession)
      const task = (async () => {
        const handle = await Reflect.apply(create, this, args) as { close(): Promise<void> }
        try { self.assertEntry(header.id); return handle }
        catch (error) { await handle.close(); throw error }
      })()
      self.track(header.id, task)
      if (header.origin === 'subagent' && header.parentSession) self.track(header.parentSession, task)
      return task
    }
    const open = host.sessionPersistence.open
    host.sessionPersistence.open = async function (...args: any[]) {
      if (args[1] !== 'write') return Reflect.apply(open, this, args)
      self.assertWritable(args[0])
      const task = (async () => {
        const handle = await Reflect.apply(open, this, args) as { close(): Promise<void> }
        try { self.assertWritable(args[0]); return handle }
        catch (error) { await handle.close(); throw error }
      })()
      self.track(args[0], task)
      return task
    }
  }
  private track(id: string, task: Promise<unknown>): void {
    const group = this.pending.get(id) ?? new Set<Promise<unknown>>()
    this.pending.set(id, group)
    group.add(task)
    const done = () => { group.delete(task); if (!group.size) this.pending.delete(id) }
    void task.then(done, done)
  }
  drain(ids: string[]): () => void {
    ids.forEach(id => this.draining.add(id))
    return () => ids.forEach(id => this.draining.delete(id))
  }
  blocks(id: string): boolean { return this.frozen.has(id) || this.fence(id) }
  setFence(fence: (id: string) => boolean): void { this.fence = fence }
  private assertEntry(id: string): void {
    if (this.blocks(id)) throw new LifecycleError('SESSION_TRASHED', '会话正在删除或已移入回收站，请先还原')
  }
  assertWritable(id: string): void {
    if (!this.internal.getStore()?.active && this.blocks(id))
      throw new LifecycleError('SESSION_TRASHED', '会话正在删除或已移入回收站，请先还原')
  }
  async own<T>(operation: () => Promise<T>): Promise<T> {
    const token = { active: true }
    return this.internal.run(token, async () => {
      try { return await operation() } finally { token.active = false }
    })
  }
  async freeze(ids: string[]): Promise<() => void> {
    ids.forEach(id => this.frozen.add(id))
    try {
      for (const id of ids) await Promise.allSettled([...(this.pending.get(id) ?? [])])
      // Preflight the entire tree before unloading any member.
      for (const id of ids) {
        const live = this.host.sessions.get(id), agent = this.host.agents.get(id)
        if ((live || agent) && (!agent || !this.handles.has(agent) || this.handles.get(agent)!.agent.session !== live))
          throw new LifecycleError('SESSION_RELEASE_UNAVAILABLE', `会话 ${id} 缺少原生释放句柄；首次升级后请正常重启 DSH 一次`)
      }
      return () => ids.forEach(id => this.frozen.delete(id))
    } catch (error) { ids.forEach(id => this.frozen.delete(id)); throw error }
  }
  async release(ids: string[]): Promise<void> {
    for (const id of [...ids].reverse()) {
      const agent = this.host.agents.get(id)
      const handle = agent && this.handles.get(agent)
      if (!handle) continue
      try { await this.own(() => handle.dispose()) }
      catch (error) { throw new LifecycleError('SESSION_RELEASE_FAILED', `会话 ${id} 释放失败：${String(error)}`) }
      if (this.host.sessions.get(id) || this.host.agents.get(id))
        throw new LifecycleError('SESSION_RELEASE_FAILED', `会话 ${id} 尚未完成释放，请稍后重试`)
      this.handles.delete(agent)
    }
  }
}

export function installSessionLifecycle(host: LifecycleHost): SessionLifecycle | undefined {
  if (host.agents[KEY]) return host.agents[KEY]
  if (typeof host.agentLoop?.initializeAgent !== 'function' ||
      typeof host.agents.create !== 'function' || typeof host.agents.resume !== 'function') return undefined
  const adapter = new SessionLifecycle(host)
  Object.defineProperty(host.agents, KEY, { value: adapter })
  return adapter
}

export function sessionLifecycleFor(agents: object): SessionLifecycle | undefined {
  return (agents as Callable)[KEY]
}

/** Class identity changes on plugin reload; the error contract does not. */
export function isLifecycleError(error: unknown): error is LifecycleError {
  return typeof error === 'object' && error !== null && (error as LifecycleError)[ERROR] === true
}
