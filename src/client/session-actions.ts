/** Shared lifecycle actions for the canvas and the native session list. */
import { uiWorkspaceService } from './map-state.ts'
import { talkMapApi } from './api.ts'
import { actionNotice, confirmAction } from './ActionSurface.tsx'
import { t } from './i18n.ts'
import type { TrashResult } from '../shared/trash.ts'
import { canvas } from './canvas-store.ts'

export function describeTrashResults(results: readonly TrashResult[]): string {
  const successes = results.filter((r) => r.status === 'trashed')
  const failures = results.filter((r) => r.status === 'failed')
  return [
    successes.length
      ? t('toast.deleted', {
          n: String(new Set(successes.flatMap((r) => r.affectedSessionIds)).size),
        })
      : '',
    ...failures.map(
      (r) => (r.sessionId ?? r.requestId) + ': ' + (r.error?.message ?? t('toast.deleteFailed')),
    ),
  ]
    .filter(Boolean)
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
    const ui = uiWorkspaceService()
    for (const item of running) {
      try {
        if (!ui?.archiveSession) throw new Error(t('toast.needUiWorkspace'))
        await ui.archiveSession(item.requestId, { stopActivity: true })
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const retry = await talkMapApi.trashSessions([item.requestId])
        results = results.map((r) => (r.requestId === item.requestId ? retry.results[0] : r))
      } catch (e) {
        results = results.map((r) =>
          r.requestId === item.requestId
            ? { ...r, error: { code: 'STOP_FAILED', message: String(e) } }
            : r,
        )
      }
    }
  }
  const entries = [
    ...new Set(
      results
        .filter((r) => r.status === 'trashed')
        .map((r) => r.entryId)
        .filter((id): id is string => id !== undefined),
    ),
  ]
  canvas.acceptTrashedSessions(
    results.filter((r) => r.status === 'trashed').flatMap((r) => r.affectedSessionIds),
  )
  actionNotice(
    describeTrashResults(results),
    entries.length
      ? () => {
          void talkMapApi
            .restoreSessions(entries)
            .then(({ results }) => {
              canvas.refresh()
              actionNotice(
                results.some((r) => r.status === 'failed')
                  ? results
                      .filter((r) => r.status === 'failed')
                      .map((r) => r.error?.message)
                      .join('\n')
                  : t('trash.restored', { n: String(results.length) }),
              )
            })
            .catch((e) => actionNotice(String(e)))
        }
      : undefined,
  )
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
