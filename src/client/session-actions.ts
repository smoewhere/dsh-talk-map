/** Shared lifecycle actions for the canvas and the native session list. */
import { uiWorkspaceService } from './map-state.ts'
import { talkMapApi, type ApiError } from './api.ts'
import { actionNotice, confirmAction } from './ActionSurface.tsx'
import { t } from './i18n.ts'
import type { TrashResult } from '../shared/trash.ts'
import { canvas } from './canvas-store.ts'

/** Successful deletion is visible in the list itself; only failures need a notice. */
function describeTrashFailures(results: readonly TrashResult[]): string {
  return results.filter(r => r.status === 'failed')
    .map(r => (r.sessionId ?? r.requestId) + ': ' + (r.error?.message ?? t('toast.deleteFailed')))
    .join('\n')
}

export async function trashSessions(
  sessionIds: readonly string[],
  title = t('trash.deleteTitle'),
): Promise<TrashResult[]> {
  const ids = [...new Set(sessionIds)]
  if (
    !ids.length ||
    !(await confirmAction(title, t('trash.deleteBody', { n: String(ids.length) })))
  )
    return []
  let { results } = await talkMapApi.trashSessions(ids)
  const running = results.filter((r) => r.error?.code === 'SESSION_RUNNING')
  if (running.length && (await confirmAction(t('trash.stopTitle'), t('trash.stopBody')))) {
    try {
      const retry = await talkMapApi.trashSessions(running.map(item => item.requestId), true)
      results = results.map(item => retry.results.find(r => r.requestId === item.requestId) ?? item)
    } catch (error) {
      results = results.map(item => running.includes(item)
        ? { ...item, error: { code: (error as ApiError).code ?? 'STOP_FAILED', message: String(error) } } : item)
    }
  }
  canvas.acceptTrashedSessions(
    results.filter(r => r.status === 'trashed').flatMap(r => r.affectedSessionIds),
  )
  const failure = describeTrashFailures(results)
  if (failure) actionNotice(failure)
  return results
}

/** Archive sessions through the shipped workspace service. Returns how many. */
export async function archiveSessions(sessionIds: readonly string[]): Promise<number> {
  const ui = uiWorkspaceService()
  if (ui === undefined || typeof ui.archiveSession !== 'function') {
    throw new Error('这个构建没有暴露归档接口')
  }
  let done = 0
  for (const sessionId of sessionIds) {
    await ui.archiveSession(sessionId, { stopActivity: true })
    done += 1
  }
  return done
}

/** Flip the shipped pin (the sidebar's own 置顶). */
export async function setPinned(sessionId: string, pinned: boolean): Promise<void> {
  const ui = uiWorkspaceService()
  const call = pinned ? ui?.pinSession : ui?.unpinSession
  if (ui === undefined || typeof call !== 'function') {
    throw new Error('这个构建没有暴露置顶接口')
  }
  await call.call(ui, sessionId)
}
