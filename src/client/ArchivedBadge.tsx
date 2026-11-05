import { t } from './i18n.ts'
import styles from './talk-map.module.css'

/** Shared archive marker for map cards, stack drawers, and group summaries. */
export function ArchivedBadge(props: { count?: number }): React.JSX.Element {
  return (
    <span className={styles['cardArchivedBadge']} data-talkmap-archived="1" title={props.count === undefined ? t('card.archivedHint') : t('card.archivedCountHint', { n: String(props.count) })}>
      {props.count === undefined ? t('card.archived') : t('card.archivedCount', { n: String(props.count) })}
    </span>
  )
}
