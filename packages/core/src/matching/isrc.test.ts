import { describe, expect, it } from 'vitest'
import { track } from './__fixtures__/tracks'
import { checkIsrc, durationWindowMs } from './isrc'
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
