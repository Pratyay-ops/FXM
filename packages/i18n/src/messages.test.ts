import { describe, expect, expectTypeOf, it } from 'vitest'
import { createI18n } from './i18n'
import { defineMessages, type MessageValues, type TagNames, type ValuesArg } from './messages'

// The assertions on types run in `make typecheck` (tsc reads this file), the rest in Vitest.

/** What a message without arguments takes: an object without properties. */
type NoValues = Record<never, never>

describe('defineMessages', () => {
  it('returns the namespace as written', () => {
    const messages = { title: 'Library' }
    expect(defineMessages('library', messages)).toEqual({ name: 'library', messages })
  })

  it('keeps the text of every message in its type', () => {
    const namespace = defineMessages('library', { title: 'Library', count: '{count} songs' })
    expectTypeOf(namespace.messages.title).toEqualTypeOf<'Library'>()
    expectTypeOf(namespace.messages.count).toEqualTypeOf<'{count} songs'>()
  })
})

describe('MessageValues', () => {
  it('takes nothing for a message without arguments', () => {
    expectTypeOf<MessageValues<'Library'>>().toEqualTypeOf<NoValues>()
    expectTypeOf<ValuesArg<'Library'>>().toEqualTypeOf<[]>()
  })

  it('takes text or a number for a plain value', () => {
    expectTypeOf<MessageValues<'By {artist}'>>().toEqualTypeOf<{
      readonly artist: string | number
    }>()
    expectTypeOf<MessageValues<'{ artist }'>>().toEqualTypeOf<{
      readonly artist: string | number
    }>()
  })

  it('takes numbers for number, plural and selectordinal arguments', () => {
    expectTypeOf<MessageValues<'{n, number}'>>().toEqualTypeOf<{ readonly n: number }>()
    expectTypeOf<MessageValues<'{n, number, percent} done'>>().toEqualTypeOf<{
      readonly n: number
    }>()
    expectTypeOf<MessageValues<'{count, plural, one {# song} other {# songs}}'>>().toEqualTypeOf<{
      readonly count: number
    }>()
    expectTypeOf<
      MessageValues<'{place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}'>
    >().toEqualTypeOf<{ readonly place: number }>()
  })

  it('takes a date or a timestamp for date and time arguments', () => {
    expectTypeOf<MessageValues<'Saved {at, time, short}'>>().toEqualTypeOf<{
      readonly at: Date | number
    }>()
    expectTypeOf<MessageValues<'Since {day, date}'>>().toEqualTypeOf<{
      readonly day: Date | number
    }>()
  })

  it('takes a string for a select', () => {
    expectTypeOf<
      MessageValues<'{tier, select, free {Free only} lite {Lite} other {Full}}'>
    >().toEqualTypeOf<{ readonly tier: string }>()
  })

  it('finds the arguments inside options, and options inside options', () => {
    type Nested =
      '{count, plural, =0 {No songs in {playlist}} one {# song in {playlist}} other {{count, number} songs, {kind, select, liked {liked} other {saved}} by {owner}}}'
    expectTypeOf<MessageValues<Nested>>().toEqualTypeOf<{
      readonly count: number
      readonly playlist: string | number
      readonly kind: string
      readonly owner: string | number
    }>()
  })

  it('reads the text after a plural as well as before it', () => {
    expectTypeOf<
      MessageValues<'{who} saved {count, plural, one {# song} other {# songs}} to {where}.'>
    >().toEqualTypeOf<{
      readonly who: string | number
      readonly count: number
      readonly where: string | number
    }>()
  })

  it('takes what every use accepts when an argument is used twice', () => {
    expectTypeOf<
      MessageValues<'{count, plural, one {One song} other {{count} songs}}'>
    >().toEqualTypeOf<{ readonly count: number }>()
  })

  it('ignores quoted braces and keeps ordinary apostrophes as text', () => {
    expectTypeOf<MessageValues<"Type '{name}' to search">>().toEqualTypeOf<NoValues>()
    expectTypeOf<MessageValues<"{artist}'s songs, '{'literal'}'">>().toEqualTypeOf<{
      readonly artist: string | number
    }>()
    expectTypeOf<MessageValues<"Can't play {title}">>().toEqualTypeOf<{
      readonly title: string | number
    }>()
  })

  it('accepts any values when the text is only known as a string', () => {
    expectTypeOf<ValuesArg<string>>().toEqualTypeOf<[values?: Readonly<Record<string, unknown>>]>()
  })
})

describe('TagNames', () => {
  it('names the tags of a message', () => {
    expectTypeOf<TagNames<'Read <link>the notes</link> and <b>agree</b>'>>().toEqualTypeOf<
      'link' | 'b'
    >()
    expectTypeOf<TagNames<'No tags, a < b'>>().toEqualTypeOf<never>()
  })
})

describe('translators', () => {
  const library = defineMessages('library', {
    title: 'Library',
    songs: '{count, plural, one {# song} other {# songs}}',
    removed: 'Removed {title} from <link>{playlist}</link>',
  })
  const t = createI18n().translator(library)

  it('type their keys and values', () => {
    expect(t('title')).toBe('Library')
    expect(t('songs', { count: 2 })).toBe('2 songs')
    // @ts-expect-error: no such key
    expect(t('titel')).toBe('library.titel')
    // @ts-expect-error: the title takes no values
    t('title', { count: 1 })
    // @ts-expect-error: songs needs its count
    expect(t('songs')).toBe('{count}')
    // @ts-expect-error: and the count is a number
    t('songs', { count: 'two' })
  })

  it('need a renderer for every tag in rich messages', () => {
    const parts = t.rich('removed', {
      title: 'Creep',
      playlist: 'Mix',
      link: (children) => ({ link: children }),
    })
    expect(parts).toEqual(['Removed Creep from ', { link: ['Mix'] }])
    // @ts-expect-error: the link tag has no renderer
    t.rich('removed', { title: 'Creep', playlist: 'Mix' })
  })
})
