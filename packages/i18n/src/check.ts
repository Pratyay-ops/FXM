/**
 * Checks for translations, for tests and CI, never for the app's bundle: a translation must not be
 * empty, must parse, take the same values as its English message, keep its tags, and give each
 * plural the forms its language needs. Also the English catalog for translation tools, and how
 * complete a locale is.
 *
 * ```ts
 * expect(checkCatalog({ locale: 'de', namespaces: ALL_NAMESPACES, catalog: de })).toEqual([])
 * ```
 *
 * @module
 */

import type { Catalog } from './i18n'
import { pluralRules } from './intl'
import type { Namespace } from './messages'
import { type MessageNode, parseMessage } from './parse'

/** Something wrong with one message. */
export interface CatalogProblem {
  /**
   * `error`: the app would show something wrong (a broken message, a value it never gets, a tag
   * nobody renders, a select's option it lacks). `warning`: worth a look (a plural form the
   * language doesn't use, a value left out, a stale key).
   */
  readonly severity: 'error' | 'warning'
  /** `<namespace>.<key>`. */
  readonly id: string
  readonly problem: string
}

/** The values and tags a message uses: argument name to kind, and tag names. */
interface Signature {
  readonly values: Map<string, string>
  readonly tags: Set<string>
  readonly plurals: { name: string; ordinal: boolean; selectors: string[] }[]
  readonly selects: Map<string, Set<string>>
}

function signature(nodes: readonly MessageNode[]): Signature {
  const found: Signature = { values: new Map(), tags: new Set(), plurals: [], selects: new Map() }
  const walk = (list: readonly MessageNode[]): void => {
    for (const node of list) {
      if (typeof node === 'string' || node.type === 'pound') continue
      if (node.type === 'tag') {
        found.tags.add(node.name)
        walk(node.children)
        continue
      }
      const kind = node.type === 'plural' ? (node.ordinal ? 'selectordinal' : 'plural') : node.type
      found.values.set(node.name, kind)
      if (node.type === 'plural') {
        found.plurals.push({
          name: node.name,
          ordinal: node.ordinal,
          selectors: Object.keys(node.options),
        })
      }
      if (node.type === 'select') {
        const keys = found.selects.get(node.name) ?? new Set<string>()
        for (const key of Object.keys(node.options)) keys.add(key)
        found.selects.set(node.name, keys)
      }
      if (node.type === 'plural' || node.type === 'select') {
        for (const option of Object.values(node.options)) walk(option)
      }
    }
  }
  walk(nodes)
  return found
}

/** Kinds that take the same values: a number fits `{n}`, `{n, number}` and a plural alike. */
const NUMERIC = new Set(['value', 'number', 'plural', 'selectordinal'])

const compatible = (source: string, translated: string): boolean =>
  source === translated || (NUMERIC.has(source) && NUMERIC.has(translated))

/**
 * Plurals that lack a form `locale` needs (an error: numbers in that form would read wrong) or
 * have one it never uses (a warning). Exact options (`=0`) are always fine.
 */
function pluralProblems(id: string, locale: string, found: Signature): CatalogProblem[] {
  const problems: CatalogProblem[] = []
  for (const plural of found.plurals) {
    const rules = pluralRules(locale, plural.ordinal ? 'ordinal' : 'cardinal')
    const needed: readonly string[] = rules.resolvedOptions().pluralCategories
    const missing = needed.filter((category) => !plural.selectors.includes(category))
    const unused = plural.selectors.filter(
      (selector) => !selector.startsWith('=') && !needed.includes(selector),
    )
    if (missing.length > 0) {
      problems.push({
        severity: 'error',
        id,
        problem: `{${plural.name}} needs the ${locale} forms ${missing.join(', ')}`,
      })
    }
    if (unused.length > 0) {
      problems.push({
        severity: 'warning',
        id,
        problem: `{${plural.name}} has forms ${locale} never uses: ${unused.join(', ')}`,
      })
    }
  }
  return problems
}

/** The syntax error of `message`, or `undefined` when it parses. */
export function syntaxError(message: string): string | undefined {
  try {
    parseMessage(message)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** What `translation`, in `locale`, gets wrong about the English message `source`. */
export function checkTranslation(options: {
  readonly id: string
  readonly locale: string
  readonly source: string
  readonly translation: string
}): CatalogProblem[] {
  const { id, locale, source, translation } = options
  const problems: CatalogProblem[] = []
  const error = (problem: string) => problems.push({ severity: 'error', id, problem })
  const warning = (problem: string) => problems.push({ severity: 'warning', id, problem })
  let english: Signature
  let translated: Signature
  try {
    english = signature(parseMessage(source))
  } catch (cause) {
    error(
      `The English message doesn't parse: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return problems
  }
  // Translation platforms write the messages nobody has translated yet as "". The app shows
  // English for them, but the file should leave them out, so it says what is translated.
  if (translation.trim() === '' && source.trim() !== '') {
    error('Is empty: leave the key out until it is translated')
    return problems
  }
  try {
    translated = signature(parseMessage(translation))
  } catch (cause) {
    error(`Doesn't parse: ${cause instanceof Error ? cause.message : String(cause)}`)
    return problems
  }
  for (const [name, kind] of translated.values) {
    const expected = english.values.get(name)
    if (expected === undefined) error(`Uses {${name}}, which the English message doesn't have`)
    else if (!compatible(expected, kind))
      error(`Uses {${name}} as ${kind}, the English message as ${expected}`)
  }
  for (const name of english.values.keys()) {
    if (!translated.values.has(name)) warning(`Leaves out {${name}}`)
  }
  for (const tag of translated.tags) {
    if (!english.tags.has(tag)) error(`Has the tag <${tag}>, which the English message doesn't`)
  }
  for (const tag of english.tags) {
    if (!translated.tags.has(tag)) error(`Leaves out the tag <${tag}>`)
  }
  // A self-closing tag is text (as in FormatJS), so the screen would show it as written.
  const selfClosing = /<[A-Za-z][\w-]*\s*\/>/.exec(translation)?.[0]
  if (selfClosing !== undefined && !source.includes(selfClosing)) {
    warning(`${selfClosing} shows as text: a self-closing tag isn't a tag`)
  }
  problems.push(...pluralProblems(id, locale, translated))
  // A value whose option a translation lacks gets its `other` text, which says something else,
  // or nothing at all where a release flag's select ends in `other {}`.
  for (const [name, keys] of english.selects) {
    const translatedKeys = translated.selects.get(name)
    const missing = [...keys].filter((key) => key !== 'other' && translatedKeys?.has(key) !== true)
    if (missing.length > 0) error(`{${name}} lacks the options ${missing.join(', ')}`)
  }
  return problems
}

/** Everything wrong with `catalog`, the translations of `locale`, against the English namespaces. */
export function checkCatalog(options: {
  readonly locale: string
  readonly namespaces: readonly Namespace[]
  readonly catalog: Catalog
}): CatalogProblem[] {
  const { locale, namespaces, catalog } = options
  const problems: CatalogProblem[] = []
  const byName = new Map(namespaces.map((namespace) => [namespace.name, namespace]))
  for (const [name, messages] of Object.entries(catalog)) {
    const namespace = byName.get(name)
    for (const [key, translation] of Object.entries(messages)) {
      const id = `${name}.${key}`
      const source =
        namespace !== undefined && Object.hasOwn(namespace.messages, key)
          ? namespace.messages[key]
          : undefined
      if (source === undefined) {
        problems.push({
          severity: 'warning',
          id,
          problem: 'No English message has this key any more',
        })
        continue
      }
      problems.push(...checkTranslation({ id, locale, source, translation }))
    }
  }
  return problems
}

/**
 * Everything wrong with the source messages themselves, in `locale` (default `en`): syntax,
 * plural forms, names that aren't camelCase words, and namespaces declared twice.
 */
export function checkSource(namespaces: readonly Namespace[], locale = 'en'): CatalogProblem[] {
  const problems: CatalogProblem[] = []
  const seen = new Set<string>()
  const camelCase = /^[a-z][a-zA-Z0-9]*$/
  for (const { name, messages } of namespaces) {
    if (seen.has(name))
      problems.push({ severity: 'error', id: name, problem: 'Two namespaces have this name' })
    seen.add(name)
    if (!camelCase.test(name)) {
      problems.push({
        severity: 'error',
        id: name,
        problem: 'A namespace name is a camelCase word',
      })
    }
    for (const [key, message] of Object.entries(messages)) {
      const id = `${name}.${key}`
      if (!camelCase.test(key))
        problems.push({ severity: 'error', id, problem: 'A key is a camelCase word' })
      try {
        problems.push(...pluralProblems(id, locale, signature(parseMessage(message))))
      } catch (error) {
        problems.push({
          severity: 'error',
          id,
          problem: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return problems
}

/** The English catalog of `namespaces`, for translation tools (`locales/en/*.json`). */
export function sourceCatalog(namespaces: readonly Namespace[]): Catalog {
  return Object.fromEntries(namespaces.map(({ name, messages }) => [name, { ...messages }]))
}

/**
 * The share of the English messages `catalog` translates, from 0 to 1. An empty message isn't a
 * translation (unless the English is empty too): the app shows English for it.
 */
export function completion(namespaces: readonly Namespace[], catalog: Catalog): number {
  let total = 0
  let translated = 0
  for (const { name, messages } of namespaces) {
    for (const [key, english] of Object.entries(messages)) {
      total += 1
      const own = catalog[name]
      const text = own !== undefined && Object.hasOwn(own, key) ? own[key] : undefined
      if (text !== undefined && (text !== '' || english === '')) translated += 1
    }
  }
  return total === 0 ? 1 : translated / total
}
