import { useEffect, useId, useRef } from 'react'
import { t } from './i18n.ts'
import { actionNotice } from './ActionSurface.tsx'
import { trashSessions } from './session-actions.ts'
import { MenuIcon } from './MenuIcons.tsx'
import { mapUi } from './map-state.ts'
import styles from './talk-map.module.css'

const openMenus = new Map<string, number>()

interface RowProps {
  sessionId: string
  displayTitle: string
  useMenuOpenState: () => [boolean, (value: boolean) => void]
}
export function NativeDeleteMenuItem(props: RowProps): React.JSX.Element {
  const [open, setOpen] = props.useMenuOpenState()
  const menuId = useId()
  useEffect(() => {
    if (!open) return
    // Escape belongs to the native menu, not the map panel behind it.
    const release = mapUi.claimEscape(`native-session-menu:${menuId}`)
    openMenus.set(props.sessionId, (openMenus.get(props.sessionId) ?? 0) + 1)
    return () => {
      release()
      const count = (openMenus.get(props.sessionId) ?? 1) - 1
      if (count > 0) openMenus.set(props.sessionId, count)
      else openMenus.delete(props.sessionId)
    }
  }, [open, props.sessionId, menuId])
  return (
    <button
      type="button"
      role="menuitem"
      className={`${styles['menuItem']} ${styles['menuItemDanger']}`}
      onClick={() => {
        setOpen(false)
        void trashSessions([props.sessionId]).catch((e) => actionNotice(String(e)))
      }}
    >
      <MenuIcon name="delete" />
      {t('menu.deleteSession')}
    </button>
  )
}

/** Legacy More-menu bridge; newer hosts already handle row context menus. */
export function NativeRowContextMenu({ sessionId }: { sessionId: string }): React.JSX.Element {
  const marker = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const node = marker.current
    const row = node?.closest<HTMLElement>('[data-row-key]')
    if (!row || row.dataset.rowKey !== `session:${sessionId}`) return
    // 0.2.2+ owns right click, keyboard invocation and pointer-positioned menus.
    // Do not intercept its React handlers or toggle that menu a second time.
    if (row.querySelector('button[data-context-menu-trigger]')) return
    // SlotOutlet renders a display:contents span. Its children include OTHER
    // plugins' buttons, so the marker's parent is not the row's action strip.
    const outlet = node?.closest('[data-slot="sidebar.workspaces.session.row.action"]')
    const more = outlet?.previousElementSibling?.querySelector<HTMLButtonElement>(
      ':scope > button[type="button"][aria-label]',
    )
    if (!more || !row.contains(more)) return
    const show = (e: Event): void => {
      if (e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      row.focus({ preventScroll: true })
      if (!openMenus.has(sessionId)) more.click()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.repeat || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) show(e)
    }
    row.addEventListener('contextmenu', show)
    row.addEventListener('keydown', key)
    return () => {
      row.removeEventListener('contextmenu', show)
      row.removeEventListener('keydown', key)
    }
  }, [sessionId])
  return <span ref={marker} hidden aria-hidden="true" />
}
