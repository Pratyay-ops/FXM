/**
 * String similarity for the matching engine: Dice on character bigrams and token-set overlap,
 * both on {@link normalizeText} output, so case, Latin diacritics, dashes and quotes never count.
 *
 * @module
 */

import { normalizeText } from '../text'

/** Everything but letters, digits and combining marks, in any script. */
const NOT_WORD = /[^\p{L}\p{N}\p{M}]+/gu

/** The normalized text with only its letters, digits and marks left: "Hi-Fi, Vol. 1" → "hifivol1". */
export function compactText(text: string): string {
  return normalizeText(text).replace(NOT_WORD, '')
}

/** The normalized words of a text, in order: "Hi-Fi, Vol. 1" → `['hi', 'fi', 'vol', '1']`. */
export function textTokens(text: string): string[] {
  return normalizeText(text)
    .split(NOT_WORD)
    .filter((token) => token !== '')
}

/** Character bigrams of the compact text; a single character is its own bigram. */
function bigrams(text: string): string[] {
  const chars = Array.from(compactText(text))
  if (chars.length === 1) return chars
  const pairs: string[] = []
  for (let i = 0; i + 1 < chars.length; i++) pairs.push(`${chars[i]}${chars[i + 1]}`)
  return pairs
}

/**
 * The Sørensen–Dice coefficient of the two texts' character bigrams, from 0 to 1, counting
 * repeated bigrams as often as they occur. Spaces and punctuation are ignored, so "Katebush" and
 * "Kate Bush" are 1. Empty texts are 0.
 */
export function diceSimilarity(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.length === 0 || right.length === 0) return 0
  const counts = new Map<string, number>()
  for (const pair of left) counts.set(pair, (counts.get(pair) ?? 0) + 1)
  let shared = 0
  for (const pair of right) {
    const count = counts.get(pair) ?? 0
    if (count > 0) {
      shared++
      counts.set(pair, count - 1)
    }
  }
  return (2 * shared) / (left.length + right.length)
}

/**
 * Token-set overlap, from 0 to 1: the share of the smaller set's distinct words found in the
 * larger, scaled by how much of the larger it covers (half weight). "Blinding Lights" against
 * "City of Blinding Lights" is 0.75; equal sets are 1.
 */
export function tokenSetSimilarity(a: string, b: string): number {
  const left = new Set(textTokens(a))
  const right = new Set(textTokens(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  const small = Math.min(left.size, right.size)
  const large = Math.max(left.size, right.size)
  return (shared / small) * (0.5 + (0.5 * shared) / large)
}

/** The larger of {@link diceSimilarity} and {@link tokenSetSimilarity}. */
export function textSimilarity(a: string, b: string): number {
  return Math.max(diceSimilarity(a, b), tokenSetSimilarity(a, b))
}

/** Whether `container`'s words include `part`'s words as one consecutive run. */
export function containsWords(container: string, part: string): boolean {
  const whole = textTokens(container)
  const run = textTokens(part)
  if (run.length === 0 || run.length > whole.length) return false
  for (let start = 0; start + run.length <= whole.length; start++) {
    if (run.every((token, offset) => whole[start + offset] === token)) return true
  }
  return false
}

/** Writing systems told apart by {@link scriptsOf}. Han and kana share one group. */
const SCRIPT_GROUPS: ReadonlyArray<readonly [string, RegExp]> = [
  ['latin', /\p{Script=Latin}/u],
  ['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}ー]/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['gurmukhi', /\p{Script=Gurmukhi}/u],
  ['gujarati', /\p{Script=Gujarati}/u],
  ['oriya', /\p{Script=Oriya}/u],
  ['tamil', /\p{Script=Tamil}/u],
  ['telugu', /\p{Script=Telugu}/u],
  ['kannada', /\p{Script=Kannada}/u],
  ['malayalam', /\p{Script=Malayalam}/u],
  ['sinhala', /\p{Script=Sinhala}/u],
  ['thai', /\p{Script=Thai}/u],
]

/**
 * The writing systems of a text's letters (`latin`, `cjk` for Han and kana, `hangul`,
 * `devanagari`, …; `other` for the rest). Digits, punctuation and symbols belong to none.
 */
export function scriptsOf(text: string): Set<string> {
  const scripts = new Set<string>()
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue
    const group = SCRIPT_GROUPS.find(([, re]) => re.test(char))
    scripts.add(group ? group[0] : 'other')
  }
  return scripts
}

/**
 * Whether two texts are written in different scripts: each has letters, and no writing system
 * is shared ("Idol" and "アイドル", "Tum Hi Ho" and "तुम ही हो").
 */
export function inDifferentScripts(a: string, b: string): boolean {
  const left = scriptsOf(a)
  const right = scriptsOf(b)
  if (left.size === 0 || right.size === 0) return false
  for (const script of left) if (right.has(script)) return false
  return true
}
