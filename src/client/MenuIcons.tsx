/**
 * Leading glyphs for the context menu. 16×16 viewBox, `currentColor`, no
 * external assets — the menu renders one 14px icon per row so the list can be
 * scanned by shape instead of read word by word.
 */
import styles from './talk-map.module.css'

export type MenuIconName =
  | 'pin'
  | 'unpin'
  | 'rename'
  | 'unread'
  | 'archive'
  | 'delete'
  | 'batch'
  | 'open'
  | 'group'
  | 'digest'

const PATHS: Record<MenuIconName, React.JSX.Element> = {
  digest: (
    <>
      <path fill="currentColor" d="M5 2h10l4 4v16H5V2zm9 1.5V7h3.5L14 3.5zM7 11h10v1.6H7V11zm0 3.4h10v1.6H7v-1.6zm0 3.4h6.5V19H7v-1.2z" />
    </>
  ),
  pin: (
    <path fill="currentColor" d="M16 8.6V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v4.6c0 1.66-1.34 3-3 3v2h5.1v7.9l.9 1 .9-1V13.6H19v-2c-1.66 0-3-1.34-3-3z" />
  ),
  unpin: (
    <>
      <path fill="currentColor" opacity="0.4" d="M16 8.6V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v4.6c0 1.66-1.34 3-3 3v2h5.1v7.9l.9 1 .9-1V13.6H19v-2c-1.66 0-3-1.34-3-3z" />
      <path fill="currentColor" d="M3.6 2.4 2.4 3.6l18 18 1.2-1.2z" />
    </>
  ),
  rename: (
    <>
      <path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" d="M14.9 3.5a2 2 0 0 1 2.9 2.9L7.4 16.8 3.4 18l1.2-4z" />
      <path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" d="M13.2 5.2 16.6 8.6" />
    </>
  ),
  unread: (
    <>
      <circle cx="12" cy="12" r="8.3" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    </>
  ),
  archive: (
    <>
      <rect x="3.2" y="4" width="17.6" height="4.6" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" d="M5.2 8.6v9.1c0 .8.6 1.4 1.4 1.4h10.8c.8 0 1.4-.6 1.4-1.4V8.6M10 12.6h4" />
    </>
  ),
  delete: (
    <>
      <path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" d="M4 6.3h16M9.5 6.3V4.1h5v2.2" />
      <path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" d="M6.3 6.3 7.5 20h9l1.2-13.7M10.3 9.9v6.4M13.7 9.9v6.4" />
    </>
  ),
  batch: (
    <>
      <rect x="3.6" y="3.6" width="8.2" height="8.2" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <rect x="10.6" y="10.6" width="9.8" height="9.8" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.9" strokeDasharray="3 2" />
    </>
  ),
  open: (
    <>
      <path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" d="M13.6 4.6h5.8v5.8M19.4 4.6 11.2 12.8" />
      <path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" d="M18 14.5v4c0 .8-.6 1.4-1.4 1.4H5.4c-.8 0-1.4-.6-1.4-1.4V7.3c0-.8.6-1.4 1.4-1.4h4" />
    </>
  ),
  group: (
    <>
      <rect x="3.4" y="4" width="17.2" height="16" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" d="M3.4 9.2h17.2" />
    </>
  ),
}

export function MenuIcon(props: { name: MenuIconName }): React.JSX.Element {
  return (
    <svg className={styles['menuIcon']} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      {PATHS[props.name]}
    </svg>
  )
}

/** DSH 0.2.2 `trash-outline` regular glyph, copied for the native session menu. */
export function DshTrashIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" strokeWidth="1" aria-hidden="true">
      <path d="M1.28149 3.88831H14.7187" stroke="currentColor" />
      <path d="M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833" stroke="currentColor" />
      <path d="M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831" stroke="currentColor" />
      <path d="M6.44946 6.98926V11.1238" stroke="currentColor" />
      <path d="M9.55054 6.98926V11.1238" stroke="currentColor" />
    </svg>
  )
}
