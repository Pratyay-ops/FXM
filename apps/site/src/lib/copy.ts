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
