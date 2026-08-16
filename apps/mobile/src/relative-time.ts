import type { Translate } from './i18n'

/**
 * Compact relative age for session rows: just now, minutes, hours, or days.
 * @param updatedAt - the row's epoch milliseconds.
 * @param now - the current epoch milliseconds.
 * @param t - the active translate function.
 * @returns the localized age string.
 */
export function relativeTime(updatedAt: number, now: number, t: Translate): string {
  const elapsed = Math.max(0, now - updatedAt)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return t('justNow')
  if (minutes < 60) return t('minutesAgo', { n: String(minutes) })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('hoursAgo', { n: String(hours) })
  return t('daysAgo', { n: String(Math.floor(hours / 24)) })
}
