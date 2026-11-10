import { useEffect, useId } from 'react'
import { t } from './i18n.ts'
import { actionNotice } from './ActionSurface.tsx'
import { trashSessions } from './session-actions.ts'
import { DshTrashIcon } from './MenuIcons.tsx'
import { mapUi } from './map-state.ts'
import styles from './talk-map.module.css'

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
    return release
  }, [open, menuId])
  return (
    <button
      type="button"
      role="menuitem"
      className={styles['nativeMenuItemDanger']}
      onClick={() => {
        setOpen(false)
        void trashSessions([props.sessionId]).catch((e) => actionNotice(String(e)))
      }}
    >
      <span className={styles['nativeMenuIcon']}>
        <DshTrashIcon />
      </span>
      {t('menu.deleteSession')}
    </button>
  )
}
