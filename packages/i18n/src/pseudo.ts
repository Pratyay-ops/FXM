/**
 * Pseudo-locales: English, changed so that what isn't translated, or doesn't fit, shows at a
 * glance. They are made from the source messages as they are shown (`createI18n`'s `derived`),
 * so they need no catalog and always cover every message.
 *
 * - `en-XA`, accented: `Settings` reads `⟦Šééţţîîñĝš⟧`. Every letter is accented, vowels are
 *   doubled (about a third longer, as many languages run), and brackets mark both ends. Plain
 *   English on screen is text that skips the translations; a missing `⟧` is text cut off.
 * - `ar-XB`, right to left: every message is wrapped in a right-to-left override, so English
 *   reads mirrored (`sgnitteS`) in a document whose direction is `rtl`, which shows the layout
 *   an Arabic or Hebrew user gets, and any physical CSS (`left`, `margin-right`) that doesn't
 *   follow it.
 *
 * Values put into a message are left alone: they are data, such as a song's title.
 *
 * ```ts
 * const i18n = createI18n({ derived: PSEUDO_LOCALES, … })
 * ```
 *
 * @module
 */

import type { DeriveMessages } from './i18n'
import type { MessageNode, MessageOptions } from './parse'

/** The marks around every accented message. `@fxm/i18n/testing` looks for them. */
export const PSEUDO_MARKS = { start: '⟦', end: '⟧' } as const

const PLAIN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const ACCENTED = Array.from('åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ')
const VOWELS = 'aeiouyAEIOUY'

/** `text` accented, with doubled vowels: `Settings` is `Šééţţîîñĝš`. */
export function accentText(text: string): string {
  let out = ''
  for (const char of text) {
    const index = PLAIN.indexOf(char)
    if (index === -1) {
      out += char
      continue
    }
    const accented = ACCENTED[index] as string
    out += VOWELS.includes(char) ? accented + accented : accented
  }
  return out
}

/** `nodes` with `change` applied to every piece of literal text, in options and tags too. */
function mapText(nodes: readonly MessageNode[], change: (text: string) => string): MessageNode[] {
  return nodes.map((node): MessageNode => {
    if (typeof node === 'string') return change(node)
    if (node.type === 'tag') return { ...node, children: mapText(node.children, change) }
    if (node.type === 'plural' || node.type === 'select') {
      const options: Record<string, readonly MessageNode[]> = {}
      for (const [selector, option] of Object.entries(node.options as MessageOptions)) {
        options[selector] = mapText(option, change)
      }
      return { ...node, options }
    }
    return node
  })
}

/** The accented pseudo-locale's messages: see the module's notes. */
export const accented: DeriveMessages = (nodes) => [
  PSEUDO_MARKS.start,
  ...mapText(nodes, accentText),
  PSEUDO_MARKS.end,
]

/** RIGHT-TO-LEFT OVERRIDE and POP DIRECTIONAL FORMATTING. */
const RLO = '\u202e'
const PDF = '\u202c'

/** The right-to-left pseudo-locale's messages: see the module's notes. */
export const bidi: DeriveMessages = (nodes) =>
  mapText(nodes, (text) => (text.trim() === '' ? text : `${RLO}${text}${PDF}`))

/** The pseudo-locales by tag, for `createI18n({ derived })`. */
export const PSEUDO_LOCALES: Readonly<Record<'en-XA' | 'ar-XB', DeriveMessages>> = {
  'en-XA': accented,
  'ar-XB': bidi,
}
