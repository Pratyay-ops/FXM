import { describe, expect, expectTypeOf, it } from 'vitest'
import * as core from '../index'

describe('the recommendation engine in the @fxm/core entry point', () => {
  it.each([
    ['identity', ['artistKeyOf', 'songIdentity', 'trackKeys', 'seedKey', 'recSeedOf']],
    ['taste', ['indexTaste', 'pickContributions', 'likedEnough', 'MIN_TASTE_ARTISTS']],
    ['pooling', ['poolCandidates', 'combineStrengths', 'fitsMode', 'DEFAULT_EVIDENCE_WEIGHTS']],
    ['scoring', ['scoreSongs', 'scoreTerms', 'SCORE_PRESETS', 'DEFAULT_SCORE_WEIGHTS']],
    ['history', ['filterHistory', 'passesHistory']],
    ['diversity', ['diversify', 'createPicker', 'songSimilarity', 'DEFAULT_PER_ARTIST_CAP']],
    ['seeds', ['planSeeds', 'seedWeight']],
    ['expansions', ['planExpansions', 'artistTrackCandidates', 'songTrackCandidates']],
    ['periods', ['periodKey', 'seededRandomFor']],
    ['home', ['buildHome', 'DEFAULT_HOME_OPTIONS', 'resolveHomeOptions', 'familiarCandidates']],
    ['stable lists', ['sanitizeStableShelves', 'sanitizeTrack', 'NO_STABLE_SHELVES']],
  ])('re-exports the %s', (_part, names) => {
    for (const name of names) expect(core).toHaveProperty(name)
  })

  it('reads the candidate format of the recommendation sources', () => {
    // A copy of `@fxm/sources/recommend`'s track candidate: its literal unions and mutable
    // arrays fit the engine's open, read-only shapes.
    interface SourcesTrackCandidate {
      type: 'track'
      source: 'ytm' | 'spotify' | 'lastfm' | 'listenbrainz'
      part: 'radio' | 'station' | 'similar-artists' | 'home'
      seed: { type: 'track' | 'artist'; id?: core.EntityId; name: string; artists?: string[] }
      rank: number
      score: number
      key: string
      attributionUrl?: string
      track: core.Track
    }
    expectTypeOf<SourcesTrackCandidate>().toExtend<core.RecCandidate>()
  })
})
