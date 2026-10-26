/**
 * Messages as code declares them: the English source of every translation, in namespaces, with
 * types read from the messages themselves.
 *
 * A namespace is the messages of code that loads together, declared next to that code
 * (`library.messages.ts`):
 *
 * ```ts
 * export const libraryMessages = defineMessages('library', {
 *   title: 'Library',
 *   songCount: '{count, plural, one {# song} other {# songs}}',
 *   removed: 'Removed “{title}” from <link>{playlist}</link>',
 * })
 * ```
 *
 * The keys are typed (`t('titel')` doesn't compile), and so are the values each message takes:
 * `t('songCount', { count: 3 })` needs a number, `t('title')` takes nothing. The types come from
 * the message text through {@link MessageValues}, so they can't drift from it.
 *
 * A namespace is one module and its messages one object, so a bundle keeps all of it with the
 * code that imports it, and can't drop the keys a chunk doesn't use. Import a namespace only from
 * modules that load together: then a lazy page carries its own English messages, and the first
 * load holds none of them (docs/I18N.md, "Namespaces and keys"). Translation files name a
 * message `<namespace>.<key>` (`library.songCount`).
 *
 * @module
 */

/** A namespace's messages: key to English message. */
export type Messages = Readonly<Record<string, string>>

/** The English messages of one namespace. */
export interface Namespace<M extends Messages = Messages> {
  /** Its name, the first part of every key in translation files (`library.title`). */
  readonly name: string
  readonly messages: M
}

/**
 * Declares a namespace's English messages. The `const` type parameter keeps each message's text
 * in its type, which is where {@link MessageValues} reads the values from.
 */
export function defineMessages<const M extends Record<string, string>>(
  name: string,
  messages: M,
): Namespace<M> {
  return { name, messages }
}

/** A key of a namespace's messages. */
export type MessageKey<M extends Messages> = keyof M & string

type Space = ' ' | '\t' | '\n' | '\r'
type TrimStart<S extends string> = S extends `${Space}${infer Rest}` ? TrimStart<Rest> : S
type TrimEnd<S extends string> = S extends `${infer Rest}${Space}` ? TrimEnd<Rest> : S
type Trim<S extends string> = TrimEnd<TrimStart<S>>

/** What an argument takes: a plain value, a number, a date or a select's key. */
type Kind = 'value' | 'number' | 'date' | 'select'

/**
 * `S` without its quoted text, which holds no arguments (`'{literal}'`, see `parse.ts`). An
 * apostrophe pair stays one apostrophe; any other apostrophe is plain text.
 */
type Unquote<
  S extends string,
  Done extends string = '',
> = S extends `${infer Before}'${infer After}`
  ? After extends `'${infer Rest}`
    ? Unquote<Rest, `${Done}${Before}'`>
    : After extends `${'{' | '}' | '<'}${string}`
      ? After extends `${string}'${infer Rest}`
        ? Unquote<Rest, `${Done}${Before}`>
        : `${Done}${Before}`
      : Unquote<After, `${Done}${Before}'`>
  : `${Done}${S}`

/**
 * The arguments of message text up to the `}` that ends it (an option's end) or the end of the
 * message: `[arguments found, the text after that }]`. Arguments are `[name, kind]` pairs.
 */
type Body<S extends string, Found> = S extends `${infer Text}{${infer Open}`
  ? Text extends `${string}}${infer Closed}`
    ? [Found, `${Closed}{${Open}`]
    : Argument<Open> extends [infer Arg, infer Rest extends string]
      ? Body<Rest, Found | Arg>
      : [Found, '']
  : S extends `${string}}${infer Closed}`
    ? [Found, Closed]
    : [Found, '']

/** The argument after a `{`: `[its arguments, the text after its }]`. */
type Argument<S extends string> = S extends `${infer Head}}${infer Tail}`
  ? Head extends `${string},${string}`
    ? S extends `${infer Name},${infer Spec}`
      ? Formatted<Trim<Name>, Spec>
      : never
    : [[Trim<Head>, 'value'], Tail]
  : never

/** An argument with a type (`number`, `date`, `plural`…), after its name's comma. */
type Formatted<
  Name extends string,
  Spec extends string,
> = Spec extends `${infer Type}}${infer Tail}`
  ? Type extends `${infer Word},${string}`
    ? Trim<Word> extends 'plural' | 'selectordinal' | 'select'
      ? Spec extends `${string},${infer Choices}`
        ? Options<Choices, [Name, Trim<Word> extends 'select' ? 'select' : 'number']>
        : never
      : [[Name, KindOf<Trim<Word>>], Tail]
    : [[Name, KindOf<Trim<Type>>], Tail]
  : never

type KindOf<Type extends string> = Type extends 'number'
  ? 'number'
  : Type extends 'date' | 'time'
    ? 'date'
    : 'value'

/** A plural's or select's options, each a body: `[arguments found, the text after its }]`. */
type Options<S extends string, Found> =
  TrimStart<S> extends `}${infer Rest}`
    ? [Found, Rest]
    : TrimStart<S> extends `${string}{${infer Open}`
      ? Body<Open, Found> extends [infer Inner, infer Rest extends string]
        ? Options<Rest, Inner>
        : [Found, '']
      : [Found, '']

/** The `[name, kind]` pairs of a message's arguments. */
type ArgumentsOf<S extends string> = Body<Unquote<S>, never>[0] extends infer Found extends
  readonly [string, Kind]
  ? Found
  : never

type ValueOf<K> = K extends 'number'
  ? number
  : K extends 'date'
    ? Date | number
    : K extends 'select'
      ? string
      : string | number

type Boxed<K> = K extends Kind ? { value: ValueOf<K> } : never
type Intersect<U> = (U extends unknown ? (box: U) => void : never) extends (box: infer I) => void
  ? I
  : never

/**
 * The values message `S` takes, read from its text: `{name}` takes a string or a number, a
 * `number`, `plural` or `selectordinal` argument a number, a `date` or `time` argument a date (or
 * its timestamp), and a `select` argument a string. An argument used twice takes what both uses
 * accept.
 */
export type MessageValues<S extends string> = {
  readonly [Name in ArgumentsOf<S>[0]]: Intersect<
    Boxed<Extract<ArgumentsOf<S>, readonly [Name, Kind]>[1]>
  > extends { value: infer V }
    ? V
    : never
}

/** The names of the tags in message `S`: `link` in `Read the <link>notes</link>`. */
export type TagNames<S extends string> = S extends `${string}</${infer Name}>${infer Rest}`
  ? Name | TagNames<Rest>
  : never

/** Values of any message, when its text isn't known to the type system. */
export type AnyValues = Readonly<Record<string, unknown>>

/**
 * The rest of a call's arguments for message `S`: nothing when it takes no values, its values when
 * it does, and any values when its text is only known as `string`.
 */
export type ValuesArg<S extends string> = string extends S
  ? [values?: AnyValues]
  : [ArgumentsOf<S>] extends [never]
    ? []
    : [values: MessageValues<S>]

/** Values for a message with tags: its values, plus a renderer for each tag. */
export type RichValues<S extends string, Children, Result> = (string extends S
  ? AnyValues
  : MessageValues<S>) & {
  readonly [Tag in TagNames<S>]: (children: Children) => Result
}
