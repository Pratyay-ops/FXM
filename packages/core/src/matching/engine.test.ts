import { describe, expect, it } from 'vitest'
import { formatId } from '../ids'
import type { Track } from '../model'
import { track } from './__fixtures__/tracks'
import { matchTrack } from './engine'
import {
  effectiveMatchBand,
  MATCHER_VERSION,
  type MatchOptions,
  type MatchPages,
  type MatchSource,
} from './types'

const AUTO: MatchOptions = { auto: true }

const SOURCE: MatchSource = {
  title: 'Blinding Lights',
  artists: [{ name: 'The Weeknd' }],
  album: { name: 'After Hours' },
  durationMs: 200000,
}

const SONG = track('J7p4bzqLvCw', 'Blinding Lights', 'The Weeknd', {
  album: 'Blinding Lights',
  seconds: 202,
})

function match(pages: MatchPages, source: MatchSource = SOURCE, options: MatchOptions = AUTO) {
  return matchTrack(source, pages, options)
}

const refs = (tracks: { ref: string }[]) => tracks.map((candidate) => candidate.ref)

describe('matchTrack: bands', () => {
  it('auto-plays a clear text match with the setting on', () => {
    const result = match({ text: [SONG] })
    expect(result.band).toBe('auto')
    expect(result.autoBlockers).toEqual([])
    expect(result.best).toMatchObject({
      source: 'ytm',
      ref: 'J7p4bzqLvCw',
      kind: 'song',
      title: 'Blinding Lights',
      artists: ['The Weeknd'],
      durationMs: 202000,
      confidence: 1,
    })
    expect(result.evidence).toEqual(['isrc no-isrc', 'best score 1.00', 'margin 1.00', 'band auto'])
    expect(result).toMatchObject({ autoEligible: true, matcherVersion: MATCHER_VERSION })
    expect(result.best?.verdict).toEqual({ band: 'auto', blockers: [], matcherVersion: 1 })
    expect(result.incomplete).toBe(false)
  })

  it('only suggests while the setting is off, with the same verdict on the best', () => {
    const result = match({ text: [SONG] }, SOURCE, {})
    expect(result.band).toBe('suggest')
    expect(result.autoBlockers).toEqual(['setting-off'])
    expect(result.evidence).toContain('blocked: setting-off')
    expect(result.autoEligible).toBe(true)
    expect(result.best?.verdict).toEqual(match({ text: [SONG] }).best?.verdict)
    expect(effectiveMatchBand(result.best?.verdict, true)).toBe('auto')
    expect(effectiveMatchBand(result.best?.verdict, false)).toBe('suggest')
  })

  it('turns the setting on only for exactly true', () => {
    const stored = { auto: 'false' } as unknown as MatchOptions
    expect(match({ text: [SONG] }, SOURCE, stored).band).toBe('suggest')
    expect(match({ text: [SONG] }, SOURCE, { auto: 1 } as unknown as MatchOptions).band).toBe(
      'suggest',
    )
  })

  it('ignores invalid thresholds, so a stored config cannot open the gate', () => {
    const broken = {
      auto: true,
      thresholds: { auto: null, autoTitle: Number.NaN, suggest: -1, isrcTopItems: 0.5 },
    } as unknown as MatchOptions
    const other = track('7hh3_SNxSSM', 'Twist It Up', 'Chubby Checker', { seconds: 156 })
    const twist: MatchSource = {
      title: 'The Twist',
      artists: [{ name: 'Chubby Checker' }],
      durationMs: 155040,
    }
    expect(match({ text: [other] }, twist, broken).autoBlockers).toEqual(['low-title'])
    const squatter = track('sq', 'You and me', 'Lil dexxy', { seconds: 155 })
    const open = { auto: true, thresholds: { isrcTitle: null, isrcArtist: null } }
    const gate = match(
      { isrcSongs: [[squatter]], isrcTopCard: null },
      { ...twist, isrc: 'USA171840050' },
      open as unknown as MatchOptions,
    )
    expect(gate.isrc.status).toBe('miss')
    expect(gate.isrc.rejected[0]?.reasons).toEqual(['artist', 'title'])
  })

  it('is none without candidates', () => {
    const result = match({})
    expect(result).toMatchObject({ band: 'none', candidates: [], autoBlockers: ['no-candidates'] })
    expect(result.best).toBeUndefined()
    expect(result.margin).toBeUndefined()
  })

  it('suggests from 0.60 and gives up below', () => {
    const outside = track('a', 'Blinding Lights', 'The Weeknd', { seconds: 207 })
    expect(match({ text: [outside] })).toMatchObject({
      band: 'suggest',
      autoBlockers: ['duration-window'],
    })
    const cover = track('b', 'Blinding Lights', 'Some Band', { seconds: 200 })
    expect(match({ text: [cover] })).toMatchObject({ band: 'none' })
    expect(match({ text: [cover] }).autoBlockers).toEqual(['low-score'])
  })

  it('never auto-plays in no-duration mode', () => {
    const { durationMs: _, ...noDuration } = SOURCE
    const result = match({ text: [SONG] }, noDuration)
    expect(result.band).toBe('suggest')
    expect(result.autoBlockers).toEqual(['no-duration'])
    expect(result.best?.confidence).toBe(1)
  })

  it('reads its thresholds from the options', () => {
    const almost = track('a', 'Blinding Lights', 'The Weeknd', { seconds: 204 })
    expect(match({ text: [almost] }).band).toBe('auto')
    const strict = match({ text: [almost] }, SOURCE, { auto: true, thresholds: { auto: 0.99 } })
    expect(strict.autoBlockers).toEqual(['low-score'])
  })
})

describe('matchTrack: the ISRC gate', () => {
  const isrcSource = { ...SOURCE, isrc: 'USUG11904206' }
  const filler = track('f', 'Lil Globglogabgalab', 'Grandayy', { kind: 'video', seconds: 43 })

  it('puts the verified item first and plays it', () => {
    const better = track('better', 'Blinding Lights', 'The Weeknd', { seconds: 200 })
    const result = match({ isrcSongs: [[filler, SONG]], text: [better] }, isrcSource)
    expect(result.band).toBe('auto')
    expect(refs(result.candidates)).toEqual(['J7p4bzqLvCw', 'better'])
    expect(result.best?.signals).toMatchObject({ isrcVerified: true })
    expect(result.best?.evidence[0]).toBe('isrc verified (songs search 1 #2)')
    expect(result.isrc.status).toBe('verified')
  })

  it('names the top-result card in the evidence', () => {
    const result = match({ isrcSongs: [[filler]], isrcTopCard: SONG }, isrcSource)
    expect(result.best?.evidence[0]).toBe('isrc verified (top-result card)')
  })

  it('keeps a verified match above 0.95 whatever its text score', () => {
    const idol = track('m9SMT5ipbxk', 'アイドル', 'YOASOBI', { seconds: 214 })
    const source: MatchSource = {
      title: 'Idol',
      artists: [{ name: 'YOASOBI' }],
      durationMs: 212000,
      isrc: 'JPP302300157',
    }
    const result = match({ isrcSongs: [[idol]] }, source)
    expect(result.band).toBe('auto')
    expect(result.best?.confidence).toBe(0.95)
  })

  it('caps a text match at suggest when a trusted ISRC misses', () => {
    const result = match({ isrcSongs: [[filler]], isrcTopCard: null, text: [SONG] }, isrcSource)
    expect(result.band).toBe('suggest')
    expect(result.autoBlockers).toEqual(['isrc-miss'])
    expect(result.isrc).toMatchObject({ status: 'miss', checkedTopCard: true })
  })

  it('suggests a verified match when Auto is off or there is no duration', () => {
    expect(match({ isrcSongs: [[SONG]] }, isrcSource, {}).band).toBe('suggest')
    const { durationMs: _, ...noDuration } = isrcSource
    const result = match({ isrcSongs: [[SONG]] }, noDuration)
    expect(result).toMatchObject({ band: 'suggest', autoBlockers: ['no-duration'] })
  })

  it('lets a fuzzy ISRC break ties but never verify or cap', () => {
    const fuzzy: MatchSource = { ...isrcSource, isrcOrigin: 'musicbrainz-fuzzy' }
    const first = track('first', 'Blinding Lights', 'The Weeknd', { seconds: 201 })
    const hinted = track('hinted', 'Blinding Lights', 'The Weeknd', { seconds: 201 })
    const result = match({ isrcSongs: [[hinted]], text: [first, hinted] }, fuzzy)
    expect(result.isrc.status).toBe('hint')
    expect(refs(result.candidates)).toEqual(['hinted', 'first'])
    expect(result.best?.signals?.isrcVerified).toBe(false)
    expect(result.best?.evidence).toContain('isrc hint (fuzzy)')
    const missed = match({ isrcSongs: [[filler]], text: [SONG] }, fuzzy)
    expect(missed.isrc.status).toBe('hint-miss')
    expect(missed.band).toBe('auto')
  })
})

describe('matchTrack: candidates', () => {
  it('keeps only what the mode lets play', () => {
    const video = track('omv', 'Blinding Lights', 'The Weeknd', {
      kind: 'music-video',
      seconds: 263,
    })
    const upload = track('ugc', 'Blinding Lights (Lyrics)', 'The Weeknd', {
      kind: 'video',
      seconds: 200,
    })
    const episode = track('ep', 'Blinding Lights', 'The Weeknd', { kind: 'episode', seconds: 200 })
    const music = match({ text: [video, episode, SONG], videos: [upload], youtube: [upload] })
    expect(refs(music.candidates)).toEqual(['J7p4bzqLvCw'])
    const all = match({ text: [video, episode, SONG], videos: [upload] }, SOURCE, {
      auto: true,
      mode: 'all',
    })
    expect(refs(all.candidates).sort()).toEqual(['J7p4bzqLvCw', 'omv', 'ugc'])
    expect(all.best?.ref).toBe('J7p4bzqLvCw')
  })

  it('de-duplicates one video found under both YouTube prefixes, keeping the first', () => {
    const plain = track('J7p4bzqLvCw', 'Blinding Lights', 'The Weeknd', {
      source: 'yt',
      kind: 'video',
      seconds: 202,
    })
    const result = match({ text: [SONG], youtube: [plain] }, SOURCE, { auto: true, mode: 'all' })
    expect(result.candidates).toHaveLength(1)
    expect(result.best?.source).toBe('ytm')
  })

  it('maps a plain YouTube video to the ytm audio source', () => {
    const plain = track('abc', 'Blinding Lights', 'The Weeknd', {
      source: 'yt',
      kind: 'video',
      seconds: 200,
    })
    const result = match({ youtube: [plain] }, SOURCE, { auto: true, mode: 'all' })
    expect(result.best).toMatchObject({ source: 'ytm', ref: 'abc', kind: 'video' })
    expect(result.band).toBe('suggest')
    expect(result.autoBlockers).toEqual(['not-song'])
  })

  it('prefers a song that reaches suggest over a better video in Music + Video mode', () => {
    const upload = track('ugc', 'Blinding Lights', 'The Weeknd', { kind: 'video', seconds: 200 })
    const song = track('song', 'Blinding Lights', 'The Weeknd', { seconds: 206 })
    const result = match({ text: [song], youtube: [upload] }, SOURCE, { auto: true, mode: 'all' })
    expect(refs(result.candidates)).toEqual(['song', 'ugc'])
    expect(result.band).toBe('suggest')
  })

  it('skips items without a valid track ID', () => {
    const bad = { ...SONG, id: 'not-an-id' } as unknown as Track
    expect(match({ text: [bad] }).candidates).toEqual([])
  })
})

describe('matchTrack: ranking', () => {
  const at = (id: string, album: string, extra: Partial<Parameters<typeof track>[3]> = {}) =>
    track(id, 'Pour Some Sugar On Me', 'Def Leppard', { album, seconds: 268, ...extra })
  const source: MatchSource = {
    title: 'Pour Some Sugar On Me',
    artists: [{ name: 'Def Leppard' }],
    album: { name: 'Hysteria' },
    durationMs: 267306,
  }

  it('breaks equal scores by album agreement after the 1.0 cap', () => {
    const deluxe = at('deluxe', 'Hysteria (Expanded Edition)')
    const exact = at('exact', 'Hysteria')
    const other = at('other', 'Rock Anthems')
    const result = match({ text: [other, deluxe, exact] }, source)
    expect(refs(result.candidates)).toEqual(['exact', 'deluxe', 'other'])
    expect(result.best?.signals?.sourceAlbumMatch).toBe(true)
    expect(result.candidates[2]?.signals?.sourceAlbumMatch).toBe(false)
  })

  it('then by year and label agreement, then page order', () => {
    const facts = { label: 'Bludgeon Riffola', releaseYear: 1987 }
    const withYear = at('year', 'Rock Anthems', { releaseDate: '1987-08-03' })
    const withLabel = at('label', 'Metal Hits')
    const plain = at('plain', 'Party Mix')
    const result = match(
      {
        text: [plain, withLabel, withYear],
        releaseFacts: { 'ytm:track:label': { label: facts.label } },
      },
      {
        ...source,
        album: { name: 'Greatest Hits' },
        label: 'Bludgeon Riffola',
        releaseDate: '1987',
      },
    )
    expect(refs(result.candidates)).toEqual(['year', 'label', 'plain'])
  })
})

describe('matchTrack: guards', () => {
  it('blocks a close rival that is not the same version (margin)', () => {
    const live = track('live', 'Blinding Lights', 'The Weeknd', { seconds: 201 })
    const remix = track('remix', 'Blinding Lights (Remix)', 'The Weeknd & Major Lazer', {
      seconds: 201,
    })
    const tight = match({ text: [live, remix] }, SOURCE, {
      auto: true,
      thresholds: { margin: 0.6 },
    })
    expect(tight.autoBlockers).toEqual(['margin'])
    expect(tight.margin).toBe(0.45)
  })

  it('does not count the same version from another release against the margin', () => {
    const single = track('single', 'Creep', 'Radiohead', { album: 'Creep', seconds: 239 })
    const lp = track('lp', 'Creep', 'Radiohead', { album: 'Pablo Honey', seconds: 238 })
    const creep: MatchSource = {
      title: 'Creep',
      artists: [{ name: 'Radiohead' }],
      album: { name: 'Pablo Honey' },
      durationMs: 236700,
    }
    const result = match({ text: [single, lp] }, creep)
    expect(result.band).toBe('auto')
    expect(result.best?.ref).toBe('lp')
    expect(result.margin).toBe(1)
  })

  it('needs a title similarity of 0.80 even when the score is high', () => {
    const twist: MatchSource = {
      title: 'The Twist',
      artists: [{ name: 'Chubby Checker' }],
      album: { name: "Dancin' Party" },
      durationMs: 155040,
    }
    const other = track('7hh3_SNxSSM', 'Twist It Up', 'Chubby Checker', {
      album: "Dancin' Party",
      seconds: 156,
    })
    const result = match({ text: [other] }, twist)
    expect(result.best?.confidence).toBeGreaterThanOrEqual(0.8)
    expect(result.autoBlockers).toEqual(['low-title'])
  })

  it('never auto-plays a clean master for an explicit source', () => {
    const clean = track('clean', 'HUMBLE.', 'Kendrick Lamar', { seconds: 177, explicit: false })
    const source: MatchSource = {
      title: 'HUMBLE.',
      artists: [{ name: 'Kendrick Lamar' }],
      durationMs: 177000,
      explicit: true,
    }
    const result = match({ text: [clean] }, source)
    expect(result.autoBlockers).toEqual(['explicit-mismatch'])
    expect(result.best?.evidence).toContain('explicit mismatch')
  })

  describe('classical', () => {
    const prelude: MatchSource = {
      title: 'Unaccompanied Cello Suite No. 1 in G major, BWV 1007: I. Prélude',
      artists: [{ name: 'Yo-Yo Ma' }],
      album: { name: 'Six Evolutions: Bach Cello Suites' },
      durationMs: 150000,
    }

    it('needs an album match', () => {
      const compilation = track('c', prelude.title, ['Yo-Yo Ma', 'Johann Sebastian Bach'], {
        album: 'Classical Meditation FM',
        seconds: 151,
      })
      expect(match({ text: [compilation] }, prelude).autoBlockers).toEqual(['classical'])
      const album = track('a', prelude.title, ['Yo-Yo Ma', 'Johann Sebastian Bach'], {
        album: 'Six Evolutions - Bach: Cello Suites',
        seconds: 151,
      })
      expect(match({ text: [album] }, prelude).band).toBe('auto')
    })
  })

  describe('re-recordings', () => {
    const everly: MatchSource = {
      title: 'Bye Bye Love',
      artists: [{ name: 'The Everly Brothers' }],
      album: { name: 'The Everly Brothers' },
      durationMs: 144333,
    }
    const at = (id: string, album: string, seconds: number, extra = {}) =>
      track(id, 'Bye Bye Love', 'The Everly Brothers', { album, seconds, ...extra })

    it('suggests when look-alikes come from other releases (rivals)', () => {
      const result = match({ text: [at('a', 'Rock Hits', 145), at('b', 'Top Hits', 142)] }, everly)
      expect(result.autoBlockers).toEqual(['rivals'])
    })

    it('lets a distinctive album match tie the best to the source release', () => {
      const result = match(
        { text: [at('a', 'The Everly Brothers', 145), at('b', 'Rock Hits', 142)] },
        everly,
      )
      expect(result.band).toBe('auto')
    })

    it('does not trust an album name that another release also has', () => {
      const result = match(
        {
          text: [
            at('a', 'The Everly Brothers', 145),
            at('b', 'The Everly Brothers', 142, { albumId: 'MPREb_other' }),
          ],
        },
        everly,
      )
      expect(result.autoBlockers).toEqual(['rivals'])
    })

    it('does not trust a generic album name', () => {
      const best = { ...everly, album: { name: 'The Very Best of The Everly Brothers' } }
      const result = match(
        { text: [at('a', 'The Very Best of The Everly Brothers', 143), at('b', 'Rock Hits', 142)] },
        best,
      )
      expect(result.autoBlockers).toEqual(['rivals'])
    })

    it('lets the release year or label tie the best to the source release', () => {
      const dated = { ...everly, releaseDate: '1958-01-01', label: 'Cadence Records' }
      const pages = { text: [at('a', 'Rock Hits', 145), at('b', 'Top Hits', 142)] }
      const year = match(
        { ...pages, releaseFacts: { 'ytm:track:a': { releaseYear: 1958 } } },
        dated,
      )
      expect(year.band).toBe('auto')
      expect(year.best?.signals).toMatchObject({ releaseYear: 1958 })
      const label = match(
        { ...pages, releaseFacts: { 'yt:track:a': { label: 'Cadence Records' } } },
        dated,
      )
      expect(label.band).toBe('auto')
      expect(label.best?.signals?.label).toBe('Cadence Records')
    })

    it('ignores look-alikes outside the window, with another version or another explicit flag', () => {
      const result = match(
        {
          text: [
            at('a', 'Rock Hits', 145, { explicit: false }),
            at('far', 'Top Hits', 150),
            track('live', 'Bye Bye Love (Live)', 'The Everly Brothers', {
              album: 'Live',
              seconds: 144,
            }),
            at('flag', 'Top Hits', 144, { explicit: true }),
          ],
        },
        everly,
      )
      // Not rivals; but with the source's explicit flag unknown, the other master is a
      // candidate of another version at the same score, so the margin blocks Auto.
      expect(result.autoBlockers).toEqual(['margin'])
      expect(result.best?.ref).toBe('a')
    })

    it('treats the same album ID with another year as another release', () => {
      const pages = {
        text: [at('a', 'Rock Hits', 145), at('b', 'Rock Hits', 142)],
        releaseFacts: {
          'ytm:track:a': { releaseYear: 1990 },
          'ytm:track:b': { releaseYear: 2001 },
        },
      }
      expect(match(pages, everly).autoBlockers).toEqual(['rivals'])
      const labels = {
        text: [at('a', 'Rock Hits', 145), at('b', 'Rock Hits', 142)],
        releaseFacts: {
          'ytm:track:a': { label: 'Cadence' },
          'ytm:track:b': { providedBy: 'Revolver' },
        },
      }
      expect(match(labels, everly).autoBlockers).toEqual(['rivals'])
      const same = {
        text: [at('a', 'Rock Hits', 145), at('b', 'Rock Hits', 142)],
        releaseFacts: { 'ytm:track:a': { label: 'Cadence' }, 'ytm:track:b': { label: 'Cadence' } },
      }
      expect(match(same, everly).band).toBe('auto')
    })

    it('demotes conflicting release facts', () => {
      const dated = {
        ...everly,
        album: { name: 'The Very Best of The Everly Brothers' },
        releaseDate: '1964-08-01',
        label: 'Rhino/Warner Records',
      }
      const early = match(
        {
          text: [at('a', 'Rock Hits', 143)],
          releaseFacts: { 'ytm:track:a': { releaseYear: 1958 } },
        },
        dated,
      )
      expect(early.autoBlockers).toEqual(['release-conflict'])
      expect(early.best?.evidence).toContain('year 1958 (conflict)')
      const label = match(
        {
          text: [at('a', 'Rock Hits', 143)],
          releaseFacts: { 'ytm:track:a': { providedBy: 'Revolver Records' } },
        },
        dated,
      )
      expect(label.autoBlockers).toEqual(['release-conflict'])
      expect(label.best?.evidence).toContain('label conflict')
    })

    it('can require album or year agreement for text matches (measured fallback)', () => {
      const options = { auto: true, requireReleaseAgreement: true }
      const none = match({ text: [at('a', 'Rock Hits', 145)] }, everly, options)
      expect(none.autoBlockers).toEqual(['release-agreement-required'])
      const album = match({ text: [at('a', 'The Everly Brothers', 145)] }, everly, options)
      expect(album.band).toBe('auto')
      const dated = { ...everly, releaseDate: '1958' }
      const year = match(
        { text: [at('a', 'Rock Hits', 145, { releaseDate: '1958-03' })] },
        dated,
        options,
      )
      expect(year.band).toBe('auto')
    })
  })
})

describe('matchTrack: signals and evidence', () => {
  it('fills in the core signals', () => {
    const result = match({ text: [SONG] })
    expect(result.best?.signals).toEqual({
      isrcVerified: false,
      sourceAlbumMatch: false,
      releaseId: 'MPREb_BlindingLights',
    })
  })

  it('leaves out a release ID from another source', () => {
    const odd: Track = {
      ...SONG,
      album: { name: 'After Hours', id: formatId('spotify', 'album', '4yP0hdKOZPNshxUOjY0cZj') },
    }
    const result = match({ text: [odd] })
    expect(result.best?.signals).toEqual({ isrcVerified: false, sourceAlbumMatch: true })
  })

  it('explains each candidate', () => {
    const lines = match({
      text: [
        track('x', 'Blinding Lights (Live) (feat. Someone)', 'The Weeknd', {
          album: 'After Hours (Deluxe)',
        }),
      ],
    }).best?.evidence
    expect(lines).toEqual([
      'title 1.00',
      'artist 1.00',
      'duration unknown',
      '+live (strong)',
      '+deluxe (soft)',
      'uncredited feat. someone',
      'album match (core)',
      'score 0.00',
    ])
    const capped = match({ text: [track('y', 'Save Your Tears', 'The Weeknd', { seconds: 200 })] })
    expect(capped.best?.evidence).toContain('cap: title')
    expect(capped.best?.evidence).toContain('duration +0.0s')
    const remix = match(
      { text: [track('z', 'Song (Alok Remix)', 'Artist', { seconds: 197 })] },
      { title: 'Song (Tiësto Remix)', artists: [{ name: 'Artist' }], durationMs: 200000 },
    )
    expect(remix.best?.evidence).toContain('different remix')
    expect(remix.best?.evidence).toContain('duration -3.0s')
  })
})

describe('matchTrack: durations', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    'treats a source duration of %d as none (no-duration mode)',
    (durationMs) => {
      const isrcSource = { ...SOURCE, durationMs, isrc: 'USUG11904206' }
      const longer = track('long', 'Blinding Lights', 'The Weeknd', { seconds: 234 })
      const result = match({ isrcSongs: [[longer]] }, isrcSource)
      expect(result.band).toBe('suggest')
      expect(result.autoBlockers).toContain('no-duration')
      expect(result.best?.evidence).toContain('duration unknown')
    },
  )

  it('gives a candidate with a broken duration no duration term and fails it at the gate', () => {
    const broken = { ...SONG, durationMs: Number.NaN }
    const isrcSource = { ...SOURCE, isrc: 'USUG11904206' }
    const result = match({ isrcSongs: [[broken]], isrcTopCard: null }, isrcSource)
    expect(result.isrc.status).toBe('miss')
    expect(result.isrc.rejected[0]?.reasons).toEqual(['duration'])
    expect(result.best?.durationMs).toBeUndefined()
    const text = match({ text: [{ ...SONG, durationMs: 0 }] })
    expect(text.best?.evidence).toContain('duration unknown')
    expect(text.best?.confidence).toBeCloseTo(0.75)
    expect(text.autoBlockers).toEqual(['low-score', 'duration-window'])
  })
})

describe('matchTrack: album anchors', () => {
  const everly: MatchSource = {
    title: 'Bye Bye Love',
    artists: [{ name: 'The Everly Brothers' }],
    album: { name: 'The Everly Brothers' },
    durationMs: 144333,
  }
  const page = {
    text: [
      track('rerecording', 'Bye Bye Love', 'The Everly Brothers', {
        album: "The Everly Brothers' Golden Hits",
        seconds: 143,
      }),
      track('original', 'Bye Bye Love', 'The Everly Brothers', {
        album: 'Rock Hits',
        seconds: 145,
      }),
    ],
  }

  it('never takes a compilation named after the artist for the source release', () => {
    const result = match(page, everly)
    expect(result.band).toBe('suggest')
    expect(result.autoBlockers).toEqual(['rivals'])
    expect(result.candidates.map((c) => c.signals?.sourceAlbumMatch)).toEqual([false, false])
    const fallback = match(page, everly, { auto: true, requireReleaseAgreement: true })
    expect(fallback.autoBlockers).toEqual(['rivals', 'release-agreement-required'])
  })

  it('ties a reissue of the source album, but not of a self-titled one', () => {
    const paranoid: MatchSource = {
      title: 'Paranoid Android',
      artists: [{ name: 'Radiohead' }],
      album: { name: 'OK Computer' },
      durationMs: 384000,
    }
    const reissue = track('reissue', 'Paranoid Android', 'Radiohead', {
      album: 'OK Computer OKNOTOK 1997 2017',
      seconds: 384,
    })
    const single = track('single', 'Paranoid Android', 'Radiohead', {
      album: 'Paranoid Android',
      seconds: 388,
    })
    const result = match({ text: [reissue, single] }, paranoid)
    expect(result.band).toBe('auto')
    expect(result.best?.signals?.sourceAlbumMatch).toBe(true)
    const selfTitled = match(
      {
        text: [
          track('a', 'Bye Bye Love', 'The Everly Brothers', {
            album: 'The Everly Brothers 1958',
            seconds: 144,
          }),
          track('b', 'Bye Bye Love', 'The Everly Brothers', { album: 'Rock Hits', seconds: 145 }),
        ],
      },
      everly,
    )
    expect(selfTitled.autoBlockers).toEqual(['rivals'])
  })

  it('refuses an anchor on a compilation even when the names are equal', () => {
    const hits = { ...everly, album: { name: 'Golden Hits' } }
    const result = match(
      {
        text: [
          track('a', 'Bye Bye Love', 'The Everly Brothers', { album: 'Golden Hits', seconds: 144 }),
          track('b', 'Bye Bye Love', 'The Everly Brothers', { album: 'Rock Hits', seconds: 145 }),
        ],
      },
      hits,
    )
    expect(result.autoBlockers).toEqual(['rivals'])
    expect(result.best?.signals?.sourceAlbumMatch).toBe(true)
  })
})

describe('matchTrack: classical credits', () => {
  const prelude = 'Unaccompanied Cello Suite No. 1 in G major, BWV 1007: I. Prélude'
  const spotify: MatchSource = {
    title: prelude,
    artists: [{ name: 'Johann Sebastian Bach' }, { name: 'Yo-Yo Ma' }],
    album: { name: 'Bach: Cello Suites' },
    durationMs: 150000,
  }
  const maisky = (seconds: number) =>
    track('maisky', prelude, ['Johann Sebastian Bach', 'Mischa Maisky'], {
      album: 'Bach: Cello Suites',
      seconds,
    })

  it('needs every credit of a composer-first source, not only the shared composer', () => {
    const result = match({ text: [maisky(151)] }, spotify)
    expect(result.best?.confidence).toBeCloseTo(0.825)
    expect(result.band).toBe('suggest')
    expect(result.autoBlockers).toEqual(['classical'])
  })

  it('never verifies another performer at the ISRC gate', () => {
    const isrcSource = { ...spotify, isrc: 'USQX91801089' }
    const result = match({ isrcSongs: [[maisky(152)]], isrcTopCard: null }, isrcSource)
    expect(result.isrc.status).toBe('miss')
    expect(result.isrc.rejected[0]?.reasons).toEqual(['artist'])
    const yoyoma = track('yoyoma', prelude, ['Yo-Yo Ma', 'Johann Sebastian Bach'], {
      album: 'Classical Meditation FM',
      seconds: 151,
    })
    const right = match({ isrcSongs: [[yoyoma]] }, isrcSource)
    expect(right.isrc.status).toBe('verified')
    expect(right.band).toBe('auto')
  })

  it('plays a text match with every credit on the source album', () => {
    const album = track('a', prelude, ['Yo-Yo Ma', 'Johann Sebastian Bach'], {
      album: 'Bach: Cello Suites',
      seconds: 151,
    })
    expect(match({ text: [album] }, spotify).band).toBe('auto')
  })
})

describe('matchTrack: album names that are not versions', () => {
  const pennyLane: MatchSource = {
    title: 'Penny Lane - Remastered 2009',
    artists: [{ name: 'The Beatles' }],
    album: { name: '1 (Remastered)' },
    durationMs: 193000,
    isrc: 'ZZTST2600001',
  }
  const onMagicalMysteryTour = track('pl', 'Penny Lane (Remastered 2009)', 'The Beatles', {
    album: 'Magical Mystery Tour (Remastered)',
    seconds: 193,
  })

  it('reads "Magical Mystery Tour" as no live album, at the gate and in text', () => {
    const gate = match({ isrcSongs: [[onMagicalMysteryTour]] }, pennyLane)
    expect(gate.isrc.status).toBe('verified')
    expect(gate.band).toBe('auto')
    const { isrc: _, ...noIsrc } = pennyLane
    expect(match({ text: [onMagicalMysteryTour] }, noIsrc).band).toBe('auto')
  })

  it('reads "Live Through This" and "Stripped" as studio albums', () => {
    const dollParts: MatchSource = {
      title: 'Doll Parts',
      artists: [{ name: 'Hole' }],
      album: { name: 'Live Through This' },
      durationMs: 211000,
      isrc: 'ZZTST2600002',
    }
    const compilation = track('dp', 'Doll Parts', 'Hole', { album: 'My Body', seconds: 211 })
    expect(match({ isrcSongs: [[compilation]] }, dollParts).isrc.status).toBe('verified')
    const { isrc: _, ...noIsrc } = dollParts
    expect(match({ text: [compilation] }, noIsrc).band).toBe('auto')
    const beautiful: MatchSource = {
      title: 'Beautiful',
      artists: [{ name: 'Christina Aguilera' }],
      album: { name: 'Stripped' },
      durationMs: 238000,
    }
    const hits = track('b', 'Beautiful', 'Christina Aguilera', { album: 'Keeps', seconds: 238 })
    expect(match({ text: [hits] }, beautiful).band).toBe('auto')
    const withIsrc = { ...beautiful, isrc: 'ZZTST2600003' }
    expect(match({ isrcSongs: [[hits]] }, withIsrc).isrc.status).toBe('verified')
  })

  it('still reads a live album as live', () => {
    const yellow: MatchSource = {
      title: 'Yellow',
      artists: [{ name: 'Coldplay' }],
      album: { name: 'Parachutes' },
      durationMs: 269000,
    }
    const live = track('live', 'Yellow', 'Coldplay', { album: 'Live 2003', seconds: 269 })
    const result = match({ text: [live] }, yellow)
    expect(result.best?.evidence).toContain('+live (strong)')
    expect(result.band).toBe('none')
  })
})

describe('matchTrack: explicit masters', () => {
  const explicit: MatchSource = {
    title: 'HUMBLE.',
    artists: [{ name: 'Kendrick Lamar' }],
    durationMs: 177000,
    explicit: true,
    isrc: 'USUM71703085',
  }
  const unmarked = track('clean', 'HUMBLE.', 'Kendrick Lamar', { seconds: 177 })
  const badged = track('explicit', 'HUMBLE.', 'Kendrick Lamar', { seconds: 177, explicit: true })

  it('takes a song without the explicit mark for the clean master', () => {
    const { isrc: _, ...noIsrc } = explicit
    const result = match({ text: [unmarked] }, noIsrc)
    expect(result.band).toBe('suggest')
    expect(result.autoBlockers).toEqual(['explicit-mismatch'])
    const both = match({ text: [unmarked, badged] }, noIsrc)
    expect(both.best?.ref).toBe('explicit')
    expect(both.band).toBe('auto')
  })

  it('never verifies the other master at the ISRC gate', () => {
    const result = match({ isrcSongs: [[unmarked, badged]] }, explicit)
    expect(result.isrc.place?.position).toBe(2)
    const only = match({ isrcSongs: [[unmarked]], isrcTopCard: null }, explicit)
    expect(only.isrc.status).toBe('miss')
    expect(only.isrc.rejected[0]?.reasons).toEqual(['explicit'])
    const clean = { ...explicit, explicit: false }
    expect(match({ isrcSongs: [[badged]] }, clean).isrc.rejected[0]?.reasons).toEqual(['explicit'])
  })
})

describe('matchTrack: featured artists at the gate', () => {
  const stayWithMe: MatchSource = {
    title: 'Stay With Me',
    artists: [{ name: 'Sam Smith' }],
    album: { name: 'In The Lonely Hour' },
    durationMs: 172000,
    isrc: 'ZZTST2600004',
  }
  const duet = track('duet', 'Stay With Me (feat. Mary J. Blige)', 'Sam Smith', {
    album: 'In The Lonely Hour (Drowning Shadows Edition)',
    seconds: 172,
  })

  it('never verifies a version with an uncredited featured artist', () => {
    const result = match({ isrcSongs: [[duet]], isrcTopCard: null }, stayWithMe)
    expect(result.isrc.status).toBe('miss')
    expect(result.isrc.rejected[0]?.reasons).toEqual(['featured'])
    expect(result.band).toBe('none')
  })

  it('lets item #1 on the source album name its sidemen', () => {
    const soWhat: MatchSource = {
      title: 'So What',
      artists: [{ name: 'Miles Davis' }],
      album: { name: 'Kind Of Blue (Legacy Edition)' },
      durationMs: 562000,
      isrc: 'USSM15900113',
    }
    const sidemen = track('so-what', 'So What (feat. John Coltrane & Bill Evans)', 'Miles Davis', {
      album: 'Kind Of Blue (Legacy Edition)',
      seconds: 563,
    })
    expect(match({ isrcSongs: [[sidemen]] }, soWhat).isrc.status).toBe('verified')
    const second = match({ isrcSongs: [[SONG, sidemen]], isrcTopCard: null }, soWhat)
    expect(second.isrc.rejected[1]?.reasons).toEqual(['featured'])
  })
})

describe('matchTrack: version tags', () => {
  const versions: Array<[string, string, string]> = [
    ['takes', 'Blue in Green (Take 3)', 'Blue in Green (Take 2)'],
    ['mixes', 'Strobe (Club Mix)', 'Strobe (VIP Mix)'],
    ['acoustic and piano', 'Someone Like You (Acoustic)', 'Someone Like You (Piano Version)'],
    ['live and Tiny Desk', 'Yellow - Live', 'Yellow (Tiny Desk Concert)'],
  ]

  it.each(versions)('tells two specific versions apart (%s)', (_name, source, candidate) => {
    const result = match(
      { text: [track('x', candidate, 'Artist', { seconds: 300 })] },
      { title: source, artists: [{ name: 'Artist' }], durationMs: 300000 },
    )
    expect(result.band).toBe('none')
    expect(result.best?.confidence).toBeLessThan(0.6)
  })

  it('matches a generic tag with a specific one of its family', () => {
    const result = match(
      {
        text: [
          track('x', 'About A Girl (Live)', 'Nirvana', {
            album: 'MTV Unplugged In New York',
            seconds: 218,
          }),
        ],
      },
      {
        title: 'About a Girl',
        artists: [{ name: 'Nirvana' }],
        album: { name: 'MTV Unplugged in New York' },
        durationMs: 218000,
      },
    )
    expect(result.band).toBe('auto')
  })
})

describe('matchTrack: release facts and ISRC origins', () => {
  const everly: MatchSource = {
    title: 'Bye Bye Love',
    artists: [{ name: 'The Everly Brothers' }],
    album: { name: 'The Very Best of The Everly Brothers' },
    durationMs: 142906,
    label: 'Rhino/Warner Records',
    releaseDate: '1964-08-01',
  }
  const original = track('8mMGkopA58c', 'Bye Bye Love', 'The Everly Brothers', {
    album: 'The Everly Brothers',
    seconds: 145,
  })

  it('refuses facts keyed by a bare videoId instead of dropping them', () => {
    const pages = {
      text: [original],
      releaseFacts: { '8mMGkopA58c': { label: 'Cadence Records' } },
    } as unknown as MatchPages
    expect(() => match(pages, everly)).toThrow(RangeError)
  })

  it('reads the label signal from the ℗ line only and names the distributor in evidence', () => {
    const result = match(
      {
        text: [original],
        releaseFacts: { 'ytm:track:8mMGkopA58c': { providedBy: 'The Orchard Enterprises' } },
      },
      everly,
    )
    expect(result.best?.signals?.label).toBeUndefined()
    expect(result.best?.evidence).toContain('provided by The Orchard Enterprises')
    const labelled = match(
      {
        text: [original],
        releaseFacts: {
          'ytm:track:8mMGkopA58c': { label: 'Cadence Records', providedBy: 'Stem Disintermedia' },
        },
      },
      everly,
    )
    expect(labelled.best?.signals?.label).toBe('Cadence Records')
    expect(labelled.autoBlockers).toEqual(['release-conflict'])
  })

  it('treats an unknown ISRC origin as a hint', () => {
    const source = {
      ...SOURCE,
      isrc: 'USUG11904206',
      isrcOrigin: 'musicbrainz-guess',
    } as unknown as MatchSource
    const result = match({ isrcSongs: [[SONG]] }, source)
    expect(result.isrc.status).toBe('hint')
    expect(result.best?.signals?.isrcVerified).toBe(false)
  })

  it('verifies one of several MusicBrainz ISRCs, and caps nothing when it misses', () => {
    const several: MatchSource = {
      ...SOURCE,
      isrc: 'USUG11904206',
      isrcOrigin: 'musicbrainz-exact-several',
    }
    expect(match({ isrcSongs: [[SONG]] }, several).isrc.status).toBe('verified')
    const filler = track('f', 'Lil Globglogabgalab', 'Grandayy', { kind: 'video', seconds: 43 })
    const missed = match({ isrcSongs: [[filler]], isrcTopCard: null, text: [SONG] }, several)
    expect(missed.isrc.status).toBe('miss')
    expect(missed.band).toBe('auto')
  })

  it('verifies a candidate whose own ISRC is the source one, after the gate checks', () => {
    const isrcSource = { ...SOURCE, isrc: 'USUG11904206' }
    const archive: Track = {
      ...track('x', 'Blinding Lights', 'The Weeknd', { seconds: 201 }),
      id: formatId('archive', 'track', 'weeknd/blinding-lights.flac'),
      source: 'archive',
      isrc: 'USUG11904206',
    }
    const result = match({ text: [archive] }, isrcSource)
    expect(result.isrc).toMatchObject({
      status: 'verified',
      place: { page: 'own-isrc', attempt: 0, position: 1 },
    })
    expect(result.best).toMatchObject({ source: 'archive', signals: { isrcVerified: true } })
    expect(result.best?.evidence[0]).toBe('isrc verified (its own ISRC)')
    const cover = { ...archive, artists: [{ name: 'Someone Else' }] }
    const refused = match({ text: [cover] }, isrcSource)
    expect(refused.isrc.status).toBe('not-run')
    expect(refused.isrc.rejected[0]).toMatchObject({ page: 'own-isrc', reasons: ['artist'] })
  })

  it('marks a match with skipped pages incomplete', () => {
    expect(match({ text: [SONG], skipped: ['album-songs'] }).incomplete).toBe(true)
  })
})
