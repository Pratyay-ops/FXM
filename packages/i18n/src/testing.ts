/**
 * Helpers for tests of translated screens.
 *
 * Tests keep asserting English: the source locale is the default, so `getByRole('button',
 * { name: 'Play' })` reads as it always did. To prove a screen has no hard-coded text left,
 * render it once in the accented pseudo-locale (`en-XA`) and ask {@link findUntranslated} what
 * still reads as plain English: every translated message is accented and bracketed there.
 *
 * ```ts
 * await i18n.setLocale('en-XA')
 * render(<NowPlaying />)
 * expect(findUntranslated(document.body, { ignore: [track.title, track.artist] })).toEqual([])
 * ```
 *
 * @module
 */

import type { MessageProblem, MissingMessage } from './i18n'
import { PSEUDO_MARKS } from './pseudo'

/** Text on screen that no translation produced. */
export interface UntranslatedText {
  readonly text: string
  /** `text` for a text node, else the attribute it was found in (`aria-label`, …). */
  readonly where: string
  readonly element: Element
}

/** The attributes people read or hear, which a translated screen translates too. */
export const TRANSLATED_ATTRIBUTES: readonly string[] = [
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'placeholder',
  'title',
]

/** Options for {@link findUntranslated}. */
export interface FindUntranslatedOptions {
  /**
   * Text that is data, not copy, such as a song's title or an address: exact strings, patterns,
   * or a test. FXM's name is ignored already.
   */
  readonly ignore?: readonly (string | RegExp)[] | ((text: string) => boolean)
}

/** Plain Latin letters: accented text has none of them. */
const PLAIN_LETTER = /[A-Za-z]/

/**
 * Every text node and translated attribute under `root` that has plain Latin letters and no
 * pseudo-locale marks, in document order. Text inside `<script>`, `<style>` and `<template>` is
 * skipped, and so is anything `ignore` accepts.
 */
export function findUntranslated(
  root: Node,
  options: FindUntranslatedOptions = {},
): UntranslatedText[] {
  const { ignore = [] } = options
  const ignored = (text: string): boolean => {
    const trimmed = text.trim()
    if (trimmed === 'FXM') return true
    if (typeof ignore === 'function') return ignore(trimmed)
    return ignore.some((rule) => (typeof rule === 'string' ? rule === trimmed : rule.test(trimmed)))
  }
  const plain = (text: string): boolean =>
    PLAIN_LETTER.test(text) &&
    !text.includes(PSEUDO_MARKS.start) &&
    !text.includes(PSEUDO_MARKS.end) &&
    !ignored(text)

  const found: UntranslatedText[] = []
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? ''
      const parent = node.parentElement
      if (parent !== null && plain(text))
        found.push({ text: text.trim(), where: 'text', element: parent })
      return
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return
    if (node.nodeType === 1) {
      const element = node as Element
      if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(element.tagName.toUpperCase()))
        return
      for (const name of TRANSLATED_ATTRIBUTES) {
        const value = element.getAttribute(name)
        if (value !== null && plain(value)) found.push({ text: value.trim(), where: name, element })
      }
    }
    for (const child of Array.from(node.childNodes)) visit(child)
  }
  visit(root)
  return found
}

/**
 * Reporters for `createI18n` that throw, so a test fails on a message it can't show: a missing
 * translation in a test catalog, a syntax error, a value the code forgot.
 */
export const strictReporters = {
  onMissing(missing: MissingMessage): never {
    throw new Error(`No ${missing.locale} message for ${missing.namespace}.${missing.key}`)
  },
  onError(problem: MessageProblem): never {
    throw new Error(`${problem.namespace}.${problem.key} in ${problem.locale}: ${problem.problem}`)
  },
} as const
