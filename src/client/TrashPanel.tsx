import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { StorageUsage, TrashEntry } from '../shared/trash.ts'
import { subscribeTrashChanges, talkMapApi } from './api.ts'
import { actionNotice, confirmAction } from './ActionSurface.tsx'
import { canvas } from './canvas-store.ts'
import { activeLocale, subscribeLocale, t } from './i18n.ts'
import { getServices } from './map-state.ts'
import styles from './talk-map.module.css'

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return t('trash.unknownSize')
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: unit ? 1 : 0 }).format(value)} ${units[unit]}`
}
function totalSize(entries: TrashEntry[]): string {
  const known = entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0)
  return formatBytes(known) + (entries.some(entry => entry.sizeBytes == null) ? ` + ${t('trash.unknownSize')}` : '')
}

export const TRASH_PANEL_ID = 'talk-map-trash'
export function openTrashPanel(): void {
  const services = getServices()
  const layout =
    services?.layout ??
    (services?.ctx?.get?.('layout') as { selectPanel(id: string): void } | undefined)
  layout?.selectPanel(TRASH_PANEL_ID)
}
export function TrashButton({ wide = true }: { wide?: boolean }): React.JSX.Element {
  useSyncExternalStore(subscribeLocale, activeLocale)
  return (
    <button
      type="button"
      className={styles[wide ? 'toggleRow' : 'toggleButton']}
      title={t('trash.title')}
      aria-label={t('trash.title')}
      onClick={openTrashPanel}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
      </svg>
      {wide && <span>{t('trash.title')}</span>}
    </button>
  )
}
export function TrashPanel(): React.JSX.Element {
  useSyncExternalStore(subscribeLocale, activeLocale)
  const [entries, setEntries] = useState<TrashEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [storage, setStorage] = useState<StorageUsage | null>(null)
  const [storageError, setStorageError] = useState(false)
  const [sort, setSort] = useState('date')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const request = useRef(0)
  const load = async (): Promise<void> => {
    const current = ++request.current
    try {
      const value = await talkMapApi.getTrash()
      if (current !== request.current) return
      setEntries(value.entries)
      setError('')
      setSelected(previous => new Set([...previous].filter(id => value.entries.some(entry => entry.entryId === id))))
    } catch (e) {
      if (current === request.current)
        setError(
          (e as { code?: string }).code === 'SERVICE_UNAVAILABLE'
            ? t('trash.unavailable')
            : t('trash.loadFailed'),
        )
    } finally {
      if (current === request.current) setLoading(false)
    }
    try {
      const value = await talkMapApi.getStorage()
      if (current === request.current) { setStorage(value); setStorageError(false) }
    } catch { if (current === request.current) setStorageError(true) }

  }
  useEffect(() => {
    void load()
    const off = subscribeTrashChanges(() => void load())
    return () => {
      off()
      request.current++
    }
  }, [])
  const run = async (action: 'restore' | 'purge', ids: string[]): Promise<void> => {
    if (busy || !ids.length) return
    if (
      action === 'purge' &&
      !(await confirmAction(t('trash.purgeTitle'), t('trash.purgeBody', { n: String(ids.length), size: totalSize(entries.filter(entry => ids.includes(entry.entryId))) })))
    )
      return
    setBusy(true)
    try {
      const { results } = await (action === 'restore'
        ? talkMapApi.restoreSessions(ids)
        : talkMapApi.purgeSessions(ids))
      const failures = results.filter((r) => r.status === 'failed')
      const succeeded = results.filter(r => r.status !== 'failed').length
      let refreshFailed = false
      // Restoring files does not attach a live Session. Pull the native list
      // explicitly instead of relying on a session/created event or a page reload.
      if (action === 'restore' && results.some(r => r.status === 'restored')) {
        try { await getServices()?.sessions.refresh?.() }
        catch { refreshFailed = true }
        canvas.refresh()
      }
      await load()
      if (succeeded) actionNotice(t(action === 'restore' ? 'trash.restored' : 'trash.purged', { n: String(succeeded) }))
      const errors = failures.map(r => `${r.sessionId ?? r.requestId}: ${r.error?.message}`)
      if (refreshFailed) errors.push(t('trash.refreshFailed'))
      if (errors.length) setError(errors.join('\n'))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const sorted = [...entries].sort((a, b) => sort === 'size'
    ? (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || b.deletedAt - a.deletedAt
    : b.deletedAt - a.deletedAt)
  return (
    <section className={styles['trashPanel']} aria-label={t('trash.title')}>
      <div className={styles['trashToolbar']}>
        <h2>{t('trash.title')}</h2>
        <button type="button" disabled={busy} onClick={() => void load()}>
          {t('trash.refresh')}
        </button>
        <button
          type="button"
          disabled={busy || !selected.size}
          onClick={() => void run('restore', [...selected])}
        >
          {t('trash.restoreSelected')}
        </button>
        <button
          type="button"
          disabled={busy || !selected.size}
          onClick={() => void run('purge', [...selected])}
        >
          {t('trash.purgeSelected')}
        </button>
      </div>
      <div className={styles['storageSummary']} aria-label={t('trash.storageTitle')}>
        <h3>{t('trash.storageTitle')}</h3>
        {storage && <dl>{([
          ['sessions', 'trash.sessionsSize'], ['projectionCache', 'trash.cacheSize'],
          ['trash', 'trash.trashSize'], ['attachments', 'trash.attachmentsSize'],
        ] as const).map(([key, label]) => <div key={key}>
          <dt>{t(label)}</dt><dd>{formatBytes(storage.categories[key].sizeBytes)}
            {!storage.categories[key].complete && <small> · {t('trash.incomplete')}</small>}</dd>
        </div>)}</dl>}
        {storage && <small>{t('trash.measuredAt', { time: new Date(storage.measuredAt).toLocaleTimeString(activeLocale()) })}</small>}
        {storageError && <p role="status">{t('trash.storageFailed')}</p>}
      </div>
      <p className={styles['trashCopy']}>{t('trash.purgeHint')}</p>
      <div className={styles['trashToolbar']}>
        <span role="status">{t('trash.summary', { total: totalSize(entries), n: String(selected.size), selected: totalSize(entries.filter(entry => selected.has(entry.entryId))) })}</span>
        <label>{t('trash.sort')} <select value={sort} onChange={event => setSort(event.target.value)}>
          <option value="date">{t('trash.sortDate')}</option><option value="size">{t('trash.sortSize')}</option>
        </select></label>
      </div>
      {error && (
        <p role="alert" className={styles['trashError']}>
          {error}
        </p>
      )}
      {loading ? (
        <p>{t('trash.loading')}</p>
      ) : entries.length === 0 ? (
        <p>{t('trash.empty')}</p>
      ) : (
        <div className={styles['trashList']}>
          {sorted.map((entry) => (
            <article key={entry.entryId} className={styles['trashEntry']}>
              <input
                type="checkbox"
                aria-label={entry.title}
                disabled={busy || entry.state !== 'trashed'}
                checked={selected.has(entry.entryId)}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev)
                    e.target.checked ? next.add(entry.entryId) : next.delete(entry.entryId)
                    return next
                  })
                }
              />
              <div className={styles['trashDetails']}>
                <strong>{entry.title}</strong>
                <code>{entry.sessionId}</code>
                <small>
                  {entry.workspace} · {new Date(entry.deletedAt).toLocaleString(activeLocale())} ·{' '}
                  {t('trash.sessionCount', { n: String(entry.sessionCount) })} · {formatBytes(entry.sizeBytes)}
                </small>
                {entry.state !== 'trashed' && (
                  <span role="alert">
                    {t('trash.recoveryFailed')} {entry.error}
                  </span>
                )}
              </div>
              <button
                type="button"
                disabled={busy || entry.state !== 'trashed'}
                onClick={() => void run('restore', [entry.entryId])}
              >
                {t('trash.restore')}
              </button>
              <button
                type="button"
                disabled={busy || entry.state !== 'trashed'}
                onClick={() => void run('purge', [entry.entryId])}
              >
                {t('trash.purge')}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
