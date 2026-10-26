import { describe, expect, it } from 'vitest'
import { FxmError, isFxmError } from '../errors'
import { formatId } from '../ids'
import type { AudioCandidate } from '../providers'
import {
  type PlaybackProblem,
  playabilityVerdictOf,
  playbackProblemError,
  playbackProblemOf,
  type SmartReplaceFacts,
  smartReplaceAction,
  UNAVAILABLE_REASONS,
  unplayableError,
} from './problems'

function candidate(ref: string): AudioCandidate {
  return {
    source: 'ytm',
    ref,
    kind: 'song',
    title: ref,
    artists: ['Artist'],
    confidence: 0.7,
    evidence: ['title 0.9'],
  }
}

const trackId = formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC')

describe('playability verdicts', () => {
  it('travel as the cause of an FxmError the player skips', () => {
    const unplayable = unplayableError({ source: 'ytm', ref: 'abc', status: 'UNPLAYABLE' })
    expect(isFxmError(unplayable, 'Unavailable')).toBe(true)
    expect(unplayable.message).toBe('ytm item abc is UNPLAYABLE')
    expect(playabilityVerdictOf(unplayable)).toEqual({
      type: 'playability',
      source: 'ytm',
      ref: 'abc',
      status: 'UNPLAYABLE',
    })
    const gone = unplayableError({
      source: 'ytm',
      ref: 'abc',
      status: 'ERROR',
      reason: 'Video unavailable',
    })
    expect(isFxmError(gone, 'NotFound')).toBe(true)
    expect(gone.message).toBe('ytm item abc is ERROR: Video unavailable')
    expect(playabilityVerdictOf(gone)?.reason).toBe('Video unavailable')
    expect(unplayableError({ source: 'ytm', ref: 'x', status: 'ERROR' }, 'custom').message).toBe(
      'custom',
    )
  })

  it('carry the source’s labelled state for the item', () => {
    const kids = unplayableError({
      source: 'ytm',
      ref: 'abc',
      status: 'UNPLAYABLE',
      state: 'made-for-kids',
    })
    expect(playabilityVerdictOf(kids)?.state).toBe('made-for-kids')
    const blank = new FxmError('Unavailable', 'x', {
      cause: { type: 'playability', source: 'ytm', ref: 'a', status: 'ERROR', state: '' },
    })
    expect(playabilityVerdictOf(blank)).not.toHaveProperty('state')
  })

  it.each([
    ['a plain error', new Error('x')],
    ['an FxmError without a cause', new FxmError('Unavailable', 'x')],
    ['a bot check', new FxmError('BotCheck', 'x', { cause: { status: 'LOGIN_REQUIRED' } })],
    [
      'another status',
      new FxmError('Unavailable', 'x', {
        cause: { type: 'playability', source: 'ytm', ref: 'a', status: 'LOGIN_REQUIRED' },
      }),
    ],
    [
      'an unknown source',
      new FxmError('Unavailable', 'x', {
        cause: { type: 'playability', source: 'nope', ref: 'a', status: 'ERROR' },
      }),
    ],
    [
      'an empty ref',
      new FxmError('Unavailable', 'x', {
        cause: { type: 'playability', source: 'ytm', ref: '', status: 'ERROR' },
      }),
    ],
  ])('are not read from %s', (_label, error) => {
    expect(playabilityVerdictOf(error)).toBeUndefined()
  })
})

describe('playback problems', () => {
  it('carry a needs-review guess and its alternatives', () => {
    const problem: PlaybackProblem = {
      type: 'needs-review',
      trackId,
      guess: candidate('guess'),
      alternatives: [candidate('other')],
    }
    const error = playbackProblemError(problem)
    expect(isFxmError(error, 'Unavailable')).toBe(true)
    expect(error.message).toContain('needs review')
    expect(playbackProblemOf(error)).toEqual(problem)
  })

  it.each(UNAVAILABLE_REASONS)('carry the unavailable reason %s', (reason) => {
    const problem: PlaybackProblem = { type: 'unavailable', trackId, reason, alternatives: [] }
    const error = playbackProblemError(problem)
    expect(error.message).toContain(reason)
    expect(playbackProblemOf(error)).toEqual(problem)
  })

  it('carry why a source refused the audio', () => {
    const problem: PlaybackProblem = {
      type: 'unavailable',
      trackId,
      reason: 'unplayable',
      alternatives: [],
      code: 'GeoBlocked',
      state: 'age-restricted',
      detail: 'Sign in to confirm your age',
    }
    const error = playbackProblemError(problem)
    expect(error.message).toBe(
      `${trackId} is unavailable (unplayable, GeoBlocked, age-restricted): Sign in to confirm your age`,
    )
    expect(playbackProblemOf(error)).toEqual(problem)
  })

  it('drop malformed refusal details', () => {
    const error = new FxmError('Unavailable', 'x', {
      cause: {
        type: 'unavailable',
        trackId,
        reason: 'unplayable',
        alternatives: [],
        code: 'Blocked',
        state: '',
        detail: 42,
      },
    })
    expect(playbackProblemOf(error)).toEqual({
      type: 'unavailable',
      trackId,
      reason: 'unplayable',
      alternatives: [],
    })
  })

  it('drop malformed alternatives and default missing ones', () => {
    const error = new FxmError('Unavailable', 'x', {
      cause: {
        type: 'unavailable',
        trackId,
        reason: 'no-match',
        alternatives: [1, candidate('a')],
      },
    })
    expect(playbackProblemOf(error)?.alternatives).toEqual([candidate('a')])
    const partial = new FxmError('Unavailable', 'x', {
      cause: {
        type: 'unavailable',
        trackId,
        reason: 'no-match',
        alternatives: [{ source: 'ytm', ref: 'only' }, null],
      },
    })
    expect(playbackProblemOf(partial)?.alternatives).toEqual([])
    const bare = new FxmError('Unavailable', 'x', {
      cause: { type: 'needs-review', trackId, guess: candidate('g') },
    })
    expect(playbackProblemOf(bare)?.alternatives).toEqual([])
  })

  it.each([
    ['a plain error', new Error('x')],
    ['an FxmError without a cause', new FxmError('Unavailable', 'x')],
    [
      'a bad track ID',
      new FxmError('Unavailable', 'x', {
        cause: { type: 'unavailable', trackId: 'x', reason: 'no-match' },
      }),
    ],
    ['an unknown type', new FxmError('Unavailable', 'x', { cause: { type: 'other', trackId } })],
    [
      'an unknown reason',
      new FxmError('Unavailable', 'x', {
        cause: { type: 'unavailable', trackId, reason: 'toString' },
      }),
    ],
    [
      'a review without a guess',
      new FxmError('Unavailable', 'x', { cause: { type: 'needs-review', trackId } }),
    ],
    [
      'a review whose guess is malformed',
      new FxmError('Unavailable', 'x', {
        cause: { type: 'needs-review', trackId, guess: { source: 'ytm', ref: 'g' } },
      }),
    ],
  ])('are not read from %s', (_label, error) => {
    expect(playbackProblemOf(error)).toBeUndefined()
  })
})

describe('smartReplaceAction: Smart Replace fires only on video-level signals', () => {
  const dead = candidate('dead')
  const verdict = playabilityVerdictOf(
    unplayableError({ source: 'ytm', ref: 'dead', status: 'UNPLAYABLE' }),
  )
  const facts = (overrides: Partial<SmartReplaceFacts>): SmartReplaceFacts => ({
    candidate: dead,
    role: 'match',
    pinned: false,
    verdict,
    othersResolve: true,
    ...overrides,
  })

  it.each<[string, Partial<SmartReplaceFacts>, string]>([
    ['UNPLAYABLE for the matched video while others resolve', {}, 'replace'],
    ['a dead linked song while others resolve', { role: 'linked-song' }, 'replace'],
    ['a verdict while nothing else resolves', { othersResolve: false }, 'keep-match'],
    [
      'a failure without a verdict (ladder, bot check, network, offline, 403)',
      { verdict: undefined },
      'keep-match',
    ],
    ['a verdict on another video', { candidate: candidate('alive') }, 'keep-match'],
    ['a pinned match, even with a verdict', { pinned: true }, 'keep-pin'],
    ['a pin without a verdict', { pinned: true, verdict: undefined }, 'keep-pin'],
    ['the track’s own video', { role: 'own' }, 'not-a-match'],
  ])('%s: %s', (_label, overrides, expected) => {
    expect(smartReplaceAction(facts(overrides))).toBe(expected)
  })
})
