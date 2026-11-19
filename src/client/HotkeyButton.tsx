/**
 * Header control: shows the current map-toggle shortcut and lets the user
 * rebind it. Click the pill, then press the new combo (must include Ctrl / Alt
 * / ⌘). Esc cancels, Backspace resets to the default. The binding itself lives
 * in `global.hotkey` and is read by the global listener in index.ts, so a save
 * here is live immediately — no reload.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { canvas } from './canvas-store.ts'
import { DEFAULT_HOTKEY, hotkeyFromEvent, hotkeyLabel } from './hotkey.ts'
import { activeLocale, subscribeLocale, t } from './i18n.ts'
import { mapUi } from './map-state.ts'
import styles from './talk-map.module.css'

/** Modifier-only keydowns (Alt, Control, Meta, Shift on their own). */
function modifierOnly(code: string): boolean {
  return code === '' || /^(Alt|Control|Meta|Shift)/.test(code)
}

function KeyboardIcon(): React.JSX.Element {
  return (
    <svg className={styles['hotkeyIcon']} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" />
    </svg>
  )
}

export function HotkeyButton(): React.JSX.Element {
  // The label follows the saved binding, so an external change (another tab,
  // an undo) shows up without remounting.
  const hotkey = useSyncExternalStore(canvas.subscribe, () => canvas.get().global?.hotkey ?? DEFAULT_HOTKEY)
  // The button lives inside the overlay, but re-render on a language switch
  // like its neighbours do.
  const locale = useSyncExternalStore(subscribeLocale, activeLocale, activeLocale)
  const [capturing, setCapturing] = useState(false)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    if (!capturing) return
    mapUi.setHotkeyCapturing(true)
    // Claim Esc so the panel's own Esc-to-close stands down while recording.
    const releaseEsc = mapUi.claimEscape('talk-map-hotkey')
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setCapturing(false)
        return
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        // Reset to the default binding.
        canvas.patchGlobalNow({ hotkey: undefined })
        setInvalid(false)
        setCapturing(false)
        return
      }
      // A lone modifier is not a binding — keep waiting for the real key.
      if (modifierOnly(event.code)) return
      const encoded = hotkeyFromEvent(event)
      if (encoded === null) {
        // A plain key with no modifier can't be captured (would fire while typing).
        setInvalid(true)
        return
      }
      canvas.patchGlobalNow({ hotkey: encoded })
      setInvalid(false)
      setCapturing(false)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      releaseEsc()
      mapUi.setHotkeyCapturing(false)
    }
  }, [capturing])

  const label = capturing
    ? t('hotkey.capture')
    : t('hotkey.label', { key: hotkeyLabel(hotkey) })
  const title = t('hotkey.hint')
  const classNames = [styles['hotkeyButton']]
  if (capturing) classNames.push(styles['hotkeyButtonCapturing'])
  if (invalid) classNames.push(styles['hotkeyButtonInvalid'])

  return (
    <button
      type="button"
      className={classNames.filter(Boolean).join(' ')}
      lang={locale}
      title={title}
      aria-label={t('hotkey.button')}
      aria-pressed={capturing}
      onClick={() => { setInvalid(false); setCapturing(value => !value) }}
    >
      <KeyboardIcon />
      <span className={styles['hotkeyLabelText']}>{invalid ? t('hotkey.invalid') : label}</span>
    </button>
  )
}
