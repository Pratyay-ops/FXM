/**
 * Helpers for copy that depends on AVAILABLE (src/config.ts), so that a sentence such as
 * "A and B are coming soon." stays grammatical when one of them ships.
 */

const list = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' })

/** Joins words the way the site writes lists: "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[]): string {
  return list.format(items)
}

/** The labels of the features that are not released yet, in their original order. */
export function unreleased(features: readonly (readonly [released: boolean, label: string])[]) {
  return features.filter(([released]) => !released).map(([, label]) => label)
}

/** "A is coming soon." or "A and b are coming soon.", or an empty string when nothing is. */
export function comingSoon(items: readonly string[]): string {
  if (items.length === 0) return ''
  const text = joinList(items)
  const verb = items.length === 1 ? 'is' : 'are'
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} ${verb} coming soon.`
}

/**
 * Where FXM runs, after "a music player": "for the web, with desktop and Android apps coming
 * soon" while neither app is out (AVAILABLE.desktop and AVAILABLE.android), "for the web, desktop
 * and Android" once both are. `later` replaces "coming soon".
 */
export function platforms(desktop: boolean, android: boolean, later = 'coming soon'): string {
  const apps = [
    [desktop, 'desktop'],
    [android, 'Android'],
  ] as const
  const out = apps.filter(([released]) => released).map(([, label]) => label)
  const upcoming = unreleased(apps)
  const where = `for ${joinList(['the web', ...out])}`
  if (upcoming.length === 0) return where
  if (upcoming.length > 1) return `${where}, with ${joinList(upcoming)} apps ${later}`
  return `${where}, with ${upcoming[0] === 'Android' ? 'an' : 'a'} ${upcoming[0]} app ${later}`
}
