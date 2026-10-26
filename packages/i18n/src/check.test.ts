import { describe, expect, it } from 'vitest'
import {
  checkCatalog,
  checkSource,
  checkTranslation,
  completion,
  sourceCatalog,
  syntaxError,
} from './check'
import { defineMessages } from './messages'

const library = defineMessages('library', {
  title: 'Library',
  songs: '{count, plural, one {# song} other {# songs}}',
  removed: 'Removed {title} from <link>{playlist}</link>',
  tier: '{tier, select, free {Free only} lite {Lite} other {Full}}',
})

const check = (key: keyof typeof library.messages, translation: string, locale = 'de') =>
  checkTranslation({ id: `library.${key}`, locale, source: library.messages[key], translation })

describe('checkTranslation', () => {
  it('accepts a faithful translation', () => {
    expect(check('songs', '{count, plural, one {# Titel} other {# Titel}}')).toEqual([])
    expect(check('removed', '{title} aus <link>{playlist}</link> entfernt')).toEqual([])
  })

  it('refuses an empty translation, which translation platforms write for untranslated keys', () => {
    expect(check('title', '')).toEqual([
      {
        severity: 'error',
        id: 'library.title',
        problem: 'Is empty: leave the key out until it is translated',
      },
    ])
    expect(check('songs', ' ').map((p) => p.problem)).toEqual([
      'Is empty: leave the key out until it is translated',
    ])
    expect(checkTranslation({ id: 'x.blank', locale: 'de', source: '', translation: '' })).toEqual(
      [],
    )
  })

  it('refuses a translation that doesn’t parse', () => {
    expect(check('title', 'Bibliothek {')).toEqual([
      { severity: 'error', id: 'library.title', problem: expect.stringContaining("Doesn't parse") },
    ])
  })

  it('refuses values the English message doesn’t have, or of another kind', () => {
    expect(check('title', 'Bibliothek von {owner}')).toEqual([
      {
        severity: 'error',
        id: 'library.title',
        problem: "Uses {owner}, which the English message doesn't have",
      },
    ])
    expect(check('songs', '{count, select, one {ein Titel} other {Titel}}')[0]?.problem).toBe(
      'Uses {count} as select, the English message as plural',
    )
    // A number fits a plain value as well as a plural.
    expect(check('songs', '{count} Titel')).toEqual([])
  })

  it('warns about values left out', () => {
    expect(check('removed', 'Entfernt aus <link>{playlist}</link>')).toEqual([
      { severity: 'warning', id: 'library.removed', problem: 'Leaves out {title}' },
    ])
  })

  it('refuses tags that differ', () => {
    expect(check('removed', '{title} aus {playlist} entfernt').map((p) => p.problem)).toEqual([
      'Leaves out the tag <link>',
    ])
    expect(
      check('removed', '{title} aus <a>{playlist}</a> entfernt').map((p) => p.problem),
    ).toEqual(["Has the tag <a>, which the English message doesn't", 'Leaves out the tag <link>'])
  })

  it('needs every plural form of the language, and warns about forms it never uses', () => {
    expect(check('songs', '{count, plural, one {# utwór} other {# utworu}}', 'pl')).toEqual([
      { severity: 'error', id: 'library.songs', problem: '{count} needs the pl forms few, many' },
    ])
    expect(
      check('songs', '{count, plural, =0 {Keine} one {# Titel} few {# Titel} other {# Titel}}'),
    ).toEqual([
      { severity: 'warning', id: 'library.songs', problem: '{count} has forms de never uses: few' },
    ])
    expect(check('songs', '{count, plural, other {# 曲}}', 'ja')).toEqual([])
  })

  it('refuses a translation that lacks one of a select’s options', () => {
    // Lite would read "Voll" (full).
    expect(check('tier', '{tier, select, free {Nur kostenlos} other {Voll}}')).toEqual([
      { severity: 'error', id: 'library.tier', problem: '{tier} lacks the options lite' },
    ])
    // A release flag's select shows nothing for a value it lacks: the hero would lose a sentence.
    const appsSoon =
      '{apps, select, both {The desktop and Android apps are coming soon.} desktop {The desktop app is coming soon.} android {The Android app is coming soon.} other {}}'
    const site = (translation: string) =>
      checkTranslation({ id: 'site.appsSoon', locale: 'de', source: appsSoon, translation })
    expect(
      site(
        '{apps, select, desktop {Die Desktop-App erscheint bald.} android {Die Android-App erscheint bald.} other {}}',
      ),
    ).toEqual([
      { severity: 'error', id: 'site.appsSoon', problem: '{apps} lacks the options both' },
    ])
    expect(
      site('Bald verfügbar.').map(({ severity, problem }) => `${severity}: ${problem}`),
    ).toEqual([
      'warning: Leaves out {apps}',
      'error: {apps} lacks the options both, desktop, android',
    ])
  })
})

describe('checkCatalog', () => {
  it('checks every translation and flags keys English no longer has', () => {
    const problems = checkCatalog({
      locale: 'de',
      namespaces: [library],
      catalog: {
        library: { title: 'Bibliothek', old: 'Alt', songs: '{n} Titel' },
        gone: { title: 'Weg' },
      },
    })
    expect(problems).toEqual([
      {
        severity: 'warning',
        id: 'library.old',
        problem: 'No English message has this key any more',
      },
      {
        severity: 'error',
        id: 'library.songs',
        problem: "Uses {n}, which the English message doesn't have",
      },
      { severity: 'warning', id: 'library.songs', problem: 'Leaves out {count}' },
      {
        severity: 'warning',
        id: 'gone.title',
        problem: 'No English message has this key any more',
      },
    ])
  })
})

describe('checkSource', () => {
  it('passes good English', () => {
    expect(checkSource([library])).toEqual([])
  })

  it('flags syntax errors, missing English plural forms, names and duplicates', () => {
    const broken = defineMessages('Broken', {
      'bad-key': 'Fine',
      plural: '{n, plural, other {# songs}}',
      syntax: '{n, plural, one {#}}',
    })
    expect(
      checkSource([broken, library, library]).map(({ id, problem }) => `${id}: ${problem}`),
    ).toEqual([
      'Broken: A namespace name is a camelCase word',
      'Broken.bad-key: A key is a camelCase word',
      'Broken.plural: {n} needs the en forms one',
      expect.stringMatching(/^Broken\.syntax: Expected an "other" option/),
      'library: Two namespaces have this name',
    ])
  })
})

describe('syntaxError', () => {
  it('returns the error, or nothing', () => {
    expect(syntaxError('{a}')).toBeUndefined()
    expect(syntaxError('{a')).toContain('Expected "}" or ","')
  })
})

describe('sourceCatalog and completion', () => {
  it('writes the English catalog for translation tools', () => {
    expect(sourceCatalog([library])).toEqual({ library: { ...library.messages } })
  })

  it('measures how much a catalog translates', () => {
    expect(completion([library], {})).toBe(0)
    expect(completion([library], { library: { title: 'Bibliothek', tier: 'x' } })).toBe(0.5)
    expect(completion([], {})).toBe(1)
  })

  it('doesn’t count empty messages as translated, unless the English is empty', () => {
    expect(completion([library], { library: { title: 'Bibliothek', songs: '', tier: '' } })).toBe(
      0.25,
    )
    const blank = defineMessages('blank', { nothing: '' })
    expect(completion([blank], { blank: { nothing: '' } })).toBe(1)
  })
})
