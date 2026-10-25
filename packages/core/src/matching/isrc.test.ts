import { describe, expect, it } from 'vitest'
import { track } from './__fixtures__/tracks'
import { checkIsrc, durationWindowMs, isrcTrust } from './isrc'
import { DEFAULT_MATCH_THRESHOLDS, type MatchSource } from './types'

const CREEP: MatchSource = {
  title: 'Creep',
  artists: [{ name: 'Radiohead' }],
  album: { name: 'Pablo Honey' },
  durationMs: 236700,
  isrc: 'GB-AYE-92-00070',
}

const RIGHT = track('9RfVp-GhKfs', 'Creep', 'Radiohead', { album: 'Creep', seconds: 239 })
const filler = (id: string, title = 'Main Yahaan Hoon', artist = 'Udit Narayan', seconds = 295) =>
  track(id, title, artist, { album: title, seconds })

describe('durationWindowMs', () => {
  it('is the larger of 5 s and 2 %', () => {
    expect(durationWindowMs(200000, DEFAULT_MATCH_THRESHOLDS)).toBe(5000)
    expect(durationWindowMs(400000, DEFAULT_MATCH_THRESHOLDS)).toBe(8000)
  })
})

describe('checkIsrc', () => {
  it('needs a valid ISRC and at least one page', () => {
    const { isrc: _, ...noIsrc } = CREEP
    expect(checkIsrc(noIsrc, { isrcSongs: [[RIGHT]] }).check.status).toBe('no-isrc')
    expect(checkIsrc({ ...CREEP, isrc: 'nope' }, { isrcSongs: [[RIGHT]] }).check.status).toBe(
      'no-isrc',
    )
    const notRun = checkIsrc(CREEP, { text: [RIGHT] }).check
    expect(notRun).toMatchObject({ status: 'not-run', isrc: 'GBAYE9200070', attempts: 0 })
  })

  it('verifies the item that passes every check', () => {
    const { check, accepted } = checkIsrc(CREEP, { isrcSongs: [[RIGHT, filler('a')]] })
    expect(check).toMatchObject({
      status: 'verified',
      isrc: 'GBAYE9200070',
      trackId: 'ytm:track:9RfVp-GhKfs',
      place: { page: 'songs', attempt: 1, position: 1 },
      attempts: 1,
      checkedTopCard: false,
    })
    expect(accepted).toBe(RIGHT)
  })

  it('checks the top five items only', () => {
    const page = [filler('a'), filler('b'), filler('c'), filler('d'), filler('e'), RIGHT]
    const { check } = checkIsrc(CREEP, { isrcSongs: [page] })
    expect(check.status).toBe('miss')
    expect(check.rejected).toHaveLength(5)
    const second = checkIsrc(CREEP, { isrcSongs: [[filler('a'), RIGHT]] }).check
    expect(second.place).toEqual({ page: 'songs', attempt: 1, position: 2 })
  })

  it('says why each item failed', () => {
    const page = [
      track('omv', 'Creep', 'Radiohead', { kind: 'music-video', seconds: 237 }),
      track('cover', 'Creep', 'Lena Hall', { seconds: 237 }),
      track('long', 'Creep', 'Radiohead', { seconds: 260 }),
      track('acoustic', 'Creep (Acoustic)', 'Radiohead', { seconds: 237 }),
      track('other', 'Just', 'Radiohead', { seconds: 237 }),
    ]
    const { check } = checkIsrc(CREEP, { isrcSongs: [page] })
    expect(check.rejected.map((item) => [item.trackId, item.reasons])).toEqual([
      ['ytm:track:omv', ['not-song']],
      ['ytm:track:cover', ['artist']],
      ['ytm:track:long', ['duration']],
      ['ytm:track:acoustic', ['version']],
      ['ytm:track:other', ['title']],
    ])
  })

  it('rejects an item without a duration unless the source has none', () => {
    const page = [track('x', 'Creep', 'Radiohead')]
    expect(checkIsrc(CREEP, { isrcSongs: [page] }).check.status).toBe('miss')
    const { durationMs: _, ...noDuration } = CREEP
    expect(checkIsrc(noDuration, { isrcSongs: [page] }).check.status).toBe('verified')
  })

  it('falls back to the top-result card, then to the retry', () => {
    const card = checkIsrc(CREEP, { isrcSongs: [[filler('a')]], isrcTopCard: RIGHT }).check
    expect(card).toMatchObject({
      status: 'verified',
      place: { page: 'top-card', attempt: 1, position: 1 },
      attempts: 1,
      checkedTopCard: true,
    })
    const retry = checkIsrc(CREEP, { isrcSongs: [[filler('a')], [RIGHT]], isrcTopCard: null }).check
    expect(retry).toMatchObject({
      status: 'verified',
      place: { page: 'songs', attempt: 2, position: 1 },
      attempts: 2,
      checkedTopCard: true,
    })
    const miss = checkIsrc(CREEP, {
      isrcSongs: [[filler('a')], [filler('b')]],
      isrcTopCard: filler('c'),
    }).check
    expect(miss).toMatchObject({ status: 'miss', attempts: 2, checkedTopCard: true })
    expect(miss.rejected.map((item) => item.page)).toEqual(['songs', 'top-card', 'songs'])
    const cardOnly = checkIsrc(CREEP, { isrcTopCard: RIGHT }).check
    expect(cardOnly).toMatchObject({ status: 'verified', attempts: 0, checkedTopCard: true })
  })

  it('prefers the item from the source album when several pass', () => {
    const single = track('single', 'Creep', 'Radiohead', { album: 'Creep', seconds: 238 })
    const album = track('album', 'Creep', 'Radiohead', { album: 'Pablo Honey', seconds: 238 })
    const { check } = checkIsrc(CREEP, { isrcSongs: [[single, album]] })
    expect(check.trackId).toBe('ytm:track:album')
  })

  it('skips the title check only for item #1 in another script', () => {
    const idol: MatchSource = {
      title: 'Idol',
      artists: [{ name: 'YOASOBI' }],
      durationMs: 212000,
      isrc: 'JPP302300157',
    }
    const native = track('m9SMT5ipbxk', 'アイドル', 'YOASOBI', { seconds: 214 })
    expect(checkIsrc(idol, { isrcSongs: [[native]] }).check.status).toBe('verified')
    const second = checkIsrc(idol, { isrcSongs: [[filler('a'), native]] }).check
    expect(second.status).toBe('miss')
    expect(second.rejected[1]?.reasons).toEqual(['title'])
    expect(checkIsrc(idol, { isrcTopCard: native }).check.status).toBe('miss')
  })

  it('never verifies another song by the same artist whose title is partly the same', () => {
    const twist: MatchSource = {
      title: 'The Twist',
      artists: [{ name: 'Chubby Checker' }],
      album: { name: "Dancin' Party" },
      durationMs: 155040,
      isrc: 'USA171840050',
    }
    const page = [
      [
        track('7hh3_SNxSSM', 'Twist It Up', 'Chubby Checker', {
          album: "Dancin' Party",
          seconds: 156,
        }),
      ],
    ]
    // ARCHITECTURE.md §12's floor of 0.5 would let it through: its title similarity is 0.53.
    expect(
      checkIsrc(twist, { isrcSongs: page }, { thresholds: { isrcTitle: 0.5 } }).check.status,
    ).toBe('verified')
    const { check } = checkIsrc(twist, { isrcSongs: page })
    expect(check.status).toBe('miss')
    expect(check.rejected[0]?.reasons).toEqual(['title'])
  })

  it('treats a fuzzy ISRC as a hint', () => {
    const fuzzy = { ...CREEP, isrcOrigin: 'musicbrainz-fuzzy' } as const
    expect(checkIsrc(fuzzy, { isrcSongs: [[RIGHT]] }).check.status).toBe('hint')
    expect(checkIsrc(fuzzy, { isrcSongs: [[filler('a')]] }).check.status).toBe('hint-miss')
    const exact = { ...CREEP, isrcOrigin: 'musicbrainz-exact' } as const
    expect(checkIsrc(exact, { isrcSongs: [[RIGHT]] }).check.status).toBe('verified')
    const several = { ...CREEP, isrcOrigin: 'musicbrainz-exact-several' } as const
    expect(checkIsrc(several, { isrcSongs: [[RIGHT]] }).check.status).toBe('verified')
    expect(checkIsrc(several, { isrcSongs: [[filler('a')]] }).check.status).toBe('miss')
  })

  it('trusts only the known origins, and fails closed on anything else', () => {
    expect(isrcTrust(undefined)).toBe('trusted')
    expect(isrcTrust('catalog')).toBe('trusted')
    expect(isrcTrust('musicbrainz-exact')).toBe('trusted')
    expect(isrcTrust('musicbrainz-exact-several')).toBe('one-of-several')
    expect(isrcTrust('musicbrainz-fuzzy')).toBe('hint')
    expect(isrcTrust('musicbrainz-guess')).toBe('hint')
    expect(isrcTrust(null)).toBe('hint')
    const guess = { ...CREEP, isrcOrigin: 'musicbrainz-guess' } as unknown as MatchSource
    expect(checkIsrc(guess, { isrcSongs: [[RIGHT]] }).check.status).toBe('hint')
  })

  it('fails the duration check closed on a broken duration', () => {
    const broken = { ...RIGHT, durationMs: Number.NaN }
    const { check } = checkIsrc(CREEP, { isrcSongs: [[broken]] })
    expect(check.rejected[0]?.reasons).toEqual(['duration'])
    for (const durationMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      const source = { ...CREEP, durationMs }
      const far = track('far', 'Creep', 'Radiohead', { seconds: 400 })
      // No source duration is no-duration mode: the gate skips the check, the band caps.
      expect(checkIsrc(source, { isrcSongs: [[far]] }).check.status).toBe('verified')
    }
  })

  it('turns down the other master and an uncredited featured artist', () => {
    const explicit = { ...CREEP, explicit: true }
    const { check } = checkIsrc(explicit, { isrcSongs: [[RIGHT]] })
    expect(check.rejected[0]?.reasons).toEqual(['explicit'])
    const marked = track('marked', 'Creep', 'Radiohead', { seconds: 238, explicit: true })
    expect(checkIsrc(explicit, { isrcSongs: [[marked]] }).check.status).toBe('verified')
    const duet = track('duet', 'Creep (feat. Someone)', 'Radiohead', { seconds: 238 })
    const featured = checkIsrc(CREEP, { isrcSongs: [[filler('a'), duet]] }).check
    expect(featured.rejected[1]?.reasons).toEqual(['featured'])
  })

  it('needs every source credit for a classical-looking title', () => {
    const prelude: MatchSource = {
      title: 'Cello Suite No. 1 in G Major, BWV 1007: I. Prélude',
      artists: [{ name: 'Johann Sebastian Bach' }, { name: 'Yo-Yo Ma' }],
      durationMs: 150000,
      isrc: 'USQX91801089',
    }
    const other = track('other', prelude.title, ['Johann Sebastian Bach', 'Mischa Maisky'], {
      seconds: 151,
    })
    const right = track('right', prelude.title, ['Yo-Yo Ma', 'Johann Sebastian Bach'], {
      seconds: 151,
    })
    expect(checkIsrc(prelude, { isrcSongs: [[other]] }).check.rejected[0]?.reasons).toEqual([
      'artist',
    ])
    expect(checkIsrc(prelude, { isrcSongs: [[other, right]] }).check.trackId).toBe(
      'ytm:track:right',
    )
  })

  it('reads its thresholds from the options', () => {
    const strict = checkIsrc(
      CREEP,
      { isrcSongs: [[RIGHT]] },
      { thresholds: { windowMs: 1000, windowRatio: 0 } },
    )
    expect(strict.check.status).toBe('miss')
    const topOne = checkIsrc(
      CREEP,
      { isrcSongs: [[filler('a'), RIGHT]] },
      { thresholds: { isrcTopItems: 1 } },
    )
    expect(topOne.check.status).toBe('miss')
  })
})
