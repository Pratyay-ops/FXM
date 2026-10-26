/**
 * The message syntax: a subset of ICU MessageFormat, which translation tools (Weblate, Crowdin,
 * Pontoon) and translators already know, parsed into a small tree.
 *
 * - `{name}`: a value. Numbers and dates are formatted for the locale, anything else is text.
 * - `{n, number}`, `{n, number, integer}`, `{n, number, percent}`.
 * - `{d, date}` and `{d, time}`, with an optional style: `short`, `medium` (the default), `long`
 *   or `full`.
 * - `{n, plural, =0 {…} one {…} other {…}}` and `{n, selectordinal, one {#st} … other {#th}}`:
 *   an exact `=n` option wins, then the locale's plural category (`Intl.PluralRules`), then
 *   `other`, which every plural needs. `#` in an option is `n`, formatted for the locale.
 * - `{v, select, a {…} b {…} other {…}}`: the option named by the value, else `other`.
 * - `<name>…</name>`: a tag around part of a message, such as a link, so a sentence stays one
 *   message. Rich formatting renders it (`Translator.rich`); plain formatting keeps what it
 *   encloses. A `<` that doesn't start a tag is plain text.
 * - Apostrophes quote as in ICU 4.8 and later (`ApostropheMode.DOUBLE_OPTIONAL`): `''` is one
 *   apostrophe; an apostrophe before `{`, `}`, `<`, or `#` inside a plural, starts quoted text that
 *   runs to the next single apostrophe; any other apostrophe is itself, so "doesn't" needs nothing.
 *
 * Everything else ICU has is refused with a {@link MessageSyntaxError}, so a message never means
 * something different here than in a translator's tool: `offset:`, skeletons (`::`), `choice`,
 * `spellout`, `duration` and `ordinal` arguments, other number and date styles, self-closing tags.
 *
 * @module
 */

/** A part of a parsed message: literal text, or one of the nodes below. */
export type MessageNode =
  | string
  | ValueNode
  | NumberNode
  | DateNode
  | PluralNode
  | SelectNode
  | PoundNode
  | TagNode

/** `{name}` */
export interface ValueNode {
  readonly type: 'value'
  readonly name: string
}

/** `{name, number}`, `{name, number, integer}` or `{name, number, percent}` */
export interface NumberNode {
  readonly type: 'number'
  readonly name: string
  readonly style?: NumberStyle
}

/** The number styles a message may ask for. */
export type NumberStyle = 'integer' | 'percent'

/** `{name, date, style}` or `{name, time, style}` */
export interface DateNode {
  readonly type: 'date' | 'time'
  readonly name: string
  readonly style: DateStyle
}

/** The date and time styles a message may ask for, as `Intl.DateTimeFormat` names them. */
export type DateStyle = 'short' | 'medium' | 'long' | 'full'

/** The options of a plural or a select: selector (`one`, `=0`, `other`) to message. */
export type MessageOptions = Readonly<Record<string, readonly MessageNode[]>>

/** `{name, plural, …}` or, with `ordinal`, `{name, selectordinal, …}` */
export interface PluralNode {
  readonly type: 'plural'
  readonly name: string
  readonly ordinal: boolean
  readonly options: MessageOptions
}

/** `{name, select, …}` */
export interface SelectNode {
  readonly type: 'select'
  readonly name: string
  readonly options: MessageOptions
}

/** `#` inside a plural option: the plural's number. */
export interface PoundNode {
  readonly type: 'pound'
}

/** `<name>children</name>` */
export interface TagNode {
  readonly type: 'tag'
  readonly name: string
  readonly children: readonly MessageNode[]
}

/** A message that doesn't follow the syntax. `offset` is where reading stopped. */
export class MessageSyntaxError extends SyntaxError {
  readonly offset: number
  readonly source: string

  constructor(reason: string, source: string, offset: number) {
    super(`${reason} at offset ${offset} of "${source}"`)
    this.name = 'MessageSyntaxError'
    this.offset = offset
    this.source = source
  }
}

/** The plural categories of Unicode CLDR, which `Intl.PluralRules` selects from. */
export const PLURAL_CATEGORIES: readonly Intl.LDMLPluralRule[] = [
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
]

const POUND: PoundNode = { type: 'pound' }
const DATE_STYLES: readonly string[] = ['short', 'medium', 'long', 'full']
const NAME = /[A-Za-z_]\w*/y
const WORD = /[A-Za-z]+/y
const PLURAL_SELECTOR = /=\d+|[a-z]+/y
const SELECT_SELECTOR = /\w+/y
const SPACE = /\s*/y
const OPEN_TAG = /<([A-Za-z][\w-]*)>/y
const CLOSE_TAG = /<\/([A-Za-z][\w-]*)>/y

/** Parses `source`; throws a {@link MessageSyntaxError} where it breaks the syntax. */
export function parseMessage(source: string): MessageNode[] {
  let at = 0

  const fail = (reason: string): never => {
    throw new MessageSyntaxError(reason, source, at)
  }

  /** Matches the sticky `pattern` at the current offset and moves past it. */
  const match = (pattern: RegExp): RegExpExecArray | null => {
    pattern.lastIndex = at
    const found = pattern.exec(source)
    if (found !== null) at = pattern.lastIndex
    return found
  }

  const read = (pattern: RegExp, what: string): string =>
    match(pattern)?.[0] ?? fail(`Expected ${what}`)

  const space = (): void => {
    match(SPACE)
  }

  const expect = (char: string): void => {
    if (source[at] !== char) fail(`Expected "${char}"`)
    at += 1
  }

  /** Text quoted by an apostrophe at `at` (see the module's notes), or the apostrophe itself. */
  const quoted = (pound: boolean): string => {
    const next = source[at + 1]
    if (next === "'") {
      at += 2
      return "'"
    }
    if (next !== '{' && next !== '}' && next !== '<' && !(pound && next === '#')) {
      at += 1
      return "'"
    }
    at += 1
    let text = ''
    while (at < source.length) {
      const char = source[at] as string
      at += 1
      if (char !== "'") text += char
      else if (source[at] === "'") {
        text += "'"
        at += 1
      } else return text
    }
    // Unterminated: ICU quotes to the end of the message.
    return text
  }

  /**
   * Message text up to the end, a `}` that isn't its own (an option's end, left for the caller)
   * or the closing tag of `tag`, which it consumes. `pound`: inside a plural, where `#` counts.
   */
  const message = (pound: boolean, tag?: string): MessageNode[] => {
    const nodes: MessageNode[] = []
    let text = ''
    const flush = (): void => {
      if (text !== '') nodes.push(text)
      text = ''
    }
    while (at < source.length) {
      const char = source[at] as string
      if (char === '}') break
      if (char === '{') {
        flush()
        nodes.push(argument(pound))
        continue
      }
      if (char === '#' && pound) {
        flush()
        nodes.push(POUND)
        at += 1
        continue
      }
      if (char === "'") {
        text += quoted(pound)
        continue
      }
      if (char === '<') {
        const start = at
        const close = match(CLOSE_TAG)
        if (close !== null) {
          if (close[1] !== tag) {
            at = start
            fail(tag === undefined ? `Unexpected </${close[1]}>` : `Expected </${tag}>`)
          }
          flush()
          return nodes
        }
        const open = match(OPEN_TAG)
        if (open !== null) {
          flush()
          const name = open[1] as string
          nodes.push({ type: 'tag', name, children: message(pound, name) })
          continue
        }
      }
      text += char
      at += 1
    }
    if (tag !== undefined) fail(`Expected </${tag}>`)
    flush()
    return nodes
  }

  /** The options of a plural or select, up to and including the `}` that ends the argument. */
  const options = (kind: 'plural' | 'select', pound: boolean): MessageOptions => {
    const found: Record<string, readonly MessageNode[]> = {}
    for (;;) {
      space()
      if (source[at] === '}') break
      if (kind === 'plural' && source.startsWith('offset:', at)) fail('"offset:" is not supported')
      const selector = read(kind === 'plural' ? PLURAL_SELECTOR : SELECT_SELECTOR, 'an option')
      if (
        kind === 'plural' &&
        !selector.startsWith('=') &&
        !PLURAL_CATEGORIES.includes(selector as Intl.LDMLPluralRule)
      ) {
        at -= selector.length
        fail(`Unknown plural category "${selector}"`)
      }
      if (Object.hasOwn(found, selector)) {
        at -= selector.length
        fail(`Option "${selector}" appears twice`)
      }
      space()
      expect('{')
      found[selector] = message(kind === 'plural' || pound)
      expect('}')
    }
    if (!Object.hasOwn(found, 'other')) fail('Expected an "other" option')
    at += 1
    return found
  }

  /** The argument whose `{` is at `at`. */
  const argument = (pound: boolean): MessageNode => {
    at += 1
    space()
    const name = read(NAME, 'an argument name')
    space()
    if (source[at] === '}') {
      at += 1
      return { type: 'value', name }
    }
    if (source[at] !== ',') fail('Expected "}" or ","')
    at += 1
    space()
    const type = read(WORD, 'an argument type')
    space()
    const style = (allowed: readonly string[], what: string): string | undefined => {
      if (source[at] !== ',') return undefined
      at += 1
      space()
      const value = read(WORD, what)
      if (!allowed.includes(value)) {
        at -= value.length
        fail(`Unsupported ${what} "${value}"`)
      }
      space()
      return value
    }
    switch (type) {
      case 'number': {
        const numberStyle = style(['integer', 'percent'], 'number style') as NumberStyle | undefined
        expect('}')
        return numberStyle === undefined
          ? { type: 'number', name }
          : { type: 'number', name, style: numberStyle }
      }
      case 'date':
      case 'time': {
        const dateStyle = (style(DATE_STYLES, `${type} style`) ?? 'medium') as DateStyle
        expect('}')
        return { type, name, style: dateStyle }
      }
      case 'plural':
      case 'selectordinal':
        expect(',')
        return {
          type: 'plural',
          name,
          ordinal: type === 'selectordinal',
          options: options('plural', pound),
        }
      case 'select':
        expect(',')
        return { type: 'select', name, options: options('select', pound) }
      default:
        at -= type.length
        return fail(`Unsupported argument type "${type}"`)
    }
  }

  const nodes = message(false)
  if (at < source.length) fail('Unexpected "}"')
  return nodes
}
