import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { StorageUsage, StorageSize } from '../shared/trash.ts'

/** Metadata-only scan. Refuse junctions/symlinks, including ancestors of the root. */
export async function directorySize(home: string, target: string): Promise<StorageSize> {
  let sizeBytes = 0, complete = true
  const root = await realpath(home)
  const rel = relative(root, resolve(target))
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../'))
    return { sizeBytes: 0, complete: false }
  let cursor = root
  try {
    for (const part of rel.split(/[\\/]/)) {
      cursor = join(cursor, part)
      if ((await lstat(cursor)).isSymbolicLink() || resolve(await realpath(cursor)) !== resolve(cursor))
        return { sizeBytes: 0, complete: false }
    }
  } catch (error) {
    return { sizeBytes: 0, complete: (error as NodeJS.ErrnoException).code === 'ENOENT' }
  }
  const walk = async (path: string): Promise<void> => {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink()) { complete = false; return }
      if (info.isFile()) { sizeBytes += info.size; return }
      if (!info.isDirectory()) { complete = false; return }
      for (const name of await readdir(path)) await walk(join(path, name))
    } catch { complete = false }
  }
  await walk(cursor)
  return { sizeBytes, complete }
}

export async function storageUsage(home: string): Promise<StorageUsage> {
  const [sessions, projectionCache, trash, attachments] = await Promise.all([
    'sessions', 'storages/session_projcache', 'talk-map-trash', 'attachments',
  ].map(path => directorySize(home, join(home, path))))
  const categories = { sessions, projectionCache, trash, attachments }
  return { categories, measuredAt: Date.now(), complete: Object.values(categories).every(v => v.complete) }
}
