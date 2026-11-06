import { useEffect, useRef, useSyncExternalStore } from 'react'
import { t } from './i18n.ts'
import { mapUi } from './map-state.ts'
import styles from './talk-map.module.css'

interface Confirmation {
  title: string
  body: string
  accept: (ok: boolean) => void
}
let confirmation: Confirmation | undefined
let notice: { text: string; undo?: () => void } | undefined
const listeners = new Set<() => void>()
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
const publish = (): void => {
  for (const fn of listeners) fn()
}
export function confirmAction(title: string, body: string): Promise<boolean> {
  if (confirmation) return Promise.resolve(false)
  return new Promise((resolve) => {
    confirmation = { title, body, accept: resolve }
    publish()
  })
}
export function actionNotice(text: string, undo?: () => void): void {
  notice = { text, undo }
  publish()
}
function finish(ok: boolean): void {
  const current = confirmation
  confirmation = undefined
  publish()
  current?.accept(ok)
}

export function ActionSurface(): React.JSX.Element | null {
  const current = useSyncExternalStore(subscribe, () => confirmation)
  const message = useSyncExternalStore(subscribe, () => notice)
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!current) return
    const before = document.activeElement as HTMLElement | null
    const release = mapUi.claimEscape('trash-confirmation')
    cancel.current?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        finish(false)
      }
      if (event.key === 'Tab') {
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button')
        if (!buttons?.length) return
        const next = event.shiftKey ? buttons[0] : buttons[buttons.length - 1]
        if (document.activeElement === next) {
          event.preventDefault()
          ;(event.shiftKey ? buttons[buttons.length - 1] : buttons[0]).focus()
        }
      }
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      release()
      before?.focus()
    }
  }, [current])
  useEffect(
    () => () => {
      finish(false)
    },
    [],
  )
  return (
    <>
      {current && (
        <div className={styles['renameBackdrop']} onClick={() => finish(false)}>
          <div
            ref={dialog}
            className={styles['renameDialog']}
            role="alertdialog"
            aria-modal="true"
            aria-label={current.title}
            aria-describedby="talk-map-confirm-description"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles['renameHeading']}>{current.title}</div>
            <p id="talk-map-confirm-description" className={styles['trashCopy']}>
              {current.body}
            </p>
            <div className={styles['renameActions']}>
              <button
                ref={cancel}
                type="button"
                className={styles['renameButton']}
                onClick={() => finish(false)}
              >
                {t('confirm.cancel')}
              </button>
              <button
                type="button"
                className={`${styles['renameButton']} ${styles['trashDanger']}`}
                onClick={() => finish(true)}
              >
                {t('trash.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
      {message && !current && (
        <div className={styles['trashNotice']} role="status">
          <span>{message.text}</span>
          {message.undo && (
            <button
              type="button"
              onClick={() => {
                notice = undefined
                publish()
                message.undo?.()
              }}
            >
              {t('trash.undo')}
            </button>
          )}
          <button
            type="button"
            aria-label={t('map.close')}
            onClick={() => {
              notice = undefined
              publish()
            }}
          >
            ×
          </button>
        </div>
      )}
    </>
  )
}
