import { FxmError, isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { PLAYER_FIXTURES, VIDEOS } from './fixtures/testing'
import { classifyPlayability, unavailableStateOf, YouTubeUnplayableError } from './playability'

type Json = { [key: string]: unknown }

/** A recorded response with some fields of `playabilityStatus` and `videoDetails` changed. */
function changed(fixture: unknown, status: Json, details: Json = {}): unknown {
  const copy = structuredClone(fixture) as Json
  copy.playabilityStatus = { ...(copy.playabilityStatus as Json), ...status }
  copy.videoDetails = { ...(copy.videoDetails as Json), ...details }
  return copy
}

describe('reading a /player response', () => {
  it('finds streams in a playable answer about the requested video', () => {
    expect(classifyPlayability(PLAYER_FIXTURES['visionos-song'], VIDEOS.song)).toEqual({
      kind: 'ok',
    })
    expect(classifyPlayability(PLAYER_FIXTURES['android-kids'], VIDEOS.kids)).toEqual({
      kind: 'ok',
    })
  })

  it('rejects an answer about another video, or one that names none', () => {
    expect(classifyPlayability(PLAYER_FIXTURES['visionos-song'], VIDEOS.kids)).toEqual({
      kind: 'mismatch',
      videoId: VIDEOS.song,
    })
    const anonymous = structuredClone(PLAYER_FIXTURES['visionos-song']) as Json
    delete anonymous.videoDetails
    expect(classifyPlayability(anonymous, VIDEOS.song)).toEqual({
      kind: 'mismatch',
      videoId: undefined,
    })
  })

  it("reads VISIONOS's LOGIN_REQUIRED without a session as a bot check", () => {
    expect(classifyPlayability(PLAYER_FIXTURES['visionos-bot-check'], VIDEOS.song)).toEqual({
      kind: 'bot-check',
      reason: 'Sign in to confirm you’re not a bot',
    })
  })

  it('reads the age gate of both clients as age-restricted, not as a bot check', () => {
    for (const name of ['visionos-age', 'android-age'] as const) {
      expect(classifyPlayability(PLAYER_FIXTURES[name], VIDEOS.age)).toMatchObject({
        kind: 'unavailable',
        state: 'age-restricted',
        status: 'LOGIN_REQUIRED',
      })
    }
    const statusOnly = { status: 'AGE_VERIFICATION_REQUIRED', desktopLegacyAgeGateReason: 0 }
    expect(
      classifyPlayability(changed(PLAYER_FIXTURES['visionos-age'], statusOnly), VIDEOS.age),
    ).toMatchObject({ kind: 'unavailable', state: 'age-restricted' })
  })

  it("reads VISIONOS's answer for a video made for kids", () => {
    expect(classifyPlayability(PLAYER_FIXTURES['visionos-kids'], VIDEOS.kids)).toEqual({
      kind: 'unavailable',
      state: 'made-for-kids',
      status: 'UNPLAYABLE',
      reason: 'This video is not available',
    })
  })

  it('reads live streams, past ones without a recording and scheduled ones as live', () => {
    for (const [name, videoId, status] of [
      ['visionos-live', VIDEOS.live, 'OK'],
      ['visionos-live-ended', VIDEOS.liveEnded, 'UNPLAYABLE'],
      ['visionos-upcoming', VIDEOS.upcoming, 'LIVE_STREAM_OFFLINE'],
    ] as const) {
      expect(classifyPlayability(PLAYER_FIXTURES[name], videoId)).toMatchObject({
        kind: 'unavailable',
        state: 'live',
        status,
      })
    }
  })

  it("reads a past stream's own reasons before calling it live", () => {
    const ended = PLAYER_FIXTURES['visionos-live-ended']
    const country = { reason: 'The uploader has not made this video available in your country' }
    const kids = { reason: 'This video is not available' }
    // As a recording that YouTube no longer serves from the live DVR, and as one it still does.
    for (const details of [{ isPostLiveDvr: false }, {}]) {
      expect(classifyPlayability(changed(ended, country, details), VIDEOS.liveEnded)).toMatchObject(
        { kind: 'geo-blocked' },
      )
      expect(classifyPlayability(changed(ended, kids, details), VIDEOS.liveEnded)).toMatchObject({
        kind: 'unavailable',
        state: 'made-for-kids',
      })
    }
    // A recording that can't play for another reason may play on another client.
    const paid = { reason: 'This video requires payment to watch' }
    expect(
      classifyPlayability(changed(ended, paid, { isPostLiveDvr: false }), VIDEOS.liveEnded),
    ).toMatchObject({ kind: 'unplayable' })
    // Without the DVR flag, the reason says the recording is missing.
    expect(
      classifyPlayability(changed(ended, {}, { isPostLiveDvr: false }), VIDEOS.liveEnded),
    ).toMatchObject({ kind: 'unavailable', state: 'live' })
    // A stream that has just ended and still plays from the DVR has no fixed file yet.
    const dvr = changed(
      PLAYER_FIXTURES['visionos-live'],
      {},
      { isLive: false, isPostLiveDvr: true },
    )
    expect(classifyPlayability(dvr, VIDEOS.live)).toMatchObject({
      kind: 'unavailable',
      state: 'live',
      status: 'OK',
    })
  })

  // No upcoming premiere could be found to record on 2026-10-26, so these change the recorded
  // scheduled stream in the two ways a premiere differs from it: it is not live content, and
  // YouTube's texts call it a premiere.
  it('reads a premiere, by its content or its wording, from the scheduled stream', () => {
    const upcoming = PLAYER_FIXTURES['visionos-upcoming']
    const uploaded = changed(upcoming, {}, { isLiveContent: false })
    const worded = changed(upcoming, { reason: 'Premieres in 3 days' })
    const airing = changed(PLAYER_FIXTURES['visionos-live'], {}, { isLiveContent: false })
    for (const [response, videoId] of [
      [uploaded, VIDEOS.upcoming],
      [worded, VIDEOS.upcoming],
      [airing, VIDEOS.live],
    ] as const) {
      expect(classifyPlayability(response, videoId)).toMatchObject({
        kind: 'unavailable',
        state: 'premiere',
      })
    }
  })

  it('tells removed, private and region-blocked videos from other unplayable ones', () => {
    const kids = PLAYER_FIXTURES['visionos-kids']
    const removed = { status: 'ERROR', reason: 'This video has been removed by the uploader' }
    expect(classifyPlayability(changed(kids, removed), VIDEOS.kids)).toMatchObject({
      kind: 'gone',
      status: 'ERROR',
    })
    const age = PLAYER_FIXTURES['visionos-age']
    const priv = { reason: 'This video is private', desktopLegacyAgeGateReason: 0 }
    expect(classifyPlayability(changed(age, priv), VIDEOS.age)).toMatchObject({ kind: 'gone' })
    const geo = {
      reason: 'Video unavailable',
      errorScreen: {
        playerErrorMessageRenderer: {
          subreason: {
            runs: [
              { text: 'The uploader has not made this video available in your ' },
              { text: 'country' },
            ],
          },
        },
      },
    }
    expect(classifyPlayability(changed(kids, geo), VIDEOS.kids)).toMatchObject({
      kind: 'geo-blocked',
      reason: 'Video unavailable',
    })
    const paid = { reason: 'This video requires payment to watch' }
    expect(classifyPlayability(changed(kids, paid), VIDEOS.kids)).toEqual({
      kind: 'unplayable',
      status: 'UNPLAYABLE',
      reason: 'This video requires payment to watch',
    })
  })

  it('reads a bot check that hides in an UNPLAYABLE reason or an alert', () => {
    const kids = PLAYER_FIXTURES['visionos-kids']
    const reason = { reason: 'Sign in to confirm you’re not a bot' }
    expect(classifyPlayability(changed(kids, reason), VIDEOS.kids)).toMatchObject({
      kind: 'bot-check',
    })
    const alerted = {
      ...(structuredClone(PLAYER_FIXTURES['visionos-song']) as Json),
      alerts: [{ alertRenderer: { text: { simpleText: "Sign in to confirm you're not a bot" } } }],
    }
    expect(classifyPlayability(alerted, VIDEOS.song)).toMatchObject({ kind: 'bot-check' })
  })

  it('reads an unknown status as unplayable, and an empty answer as a mismatch', () => {
    const odd = changed(PLAYER_FIXTURES['visionos-kids'], { status: 'SOMETHING_NEW', reason: '' })
    expect(classifyPlayability(odd, VIDEOS.kids)).toEqual({
      kind: 'unplayable',
      status: 'SOMETHING_NEW',
      reason: '',
    })
    expect(classifyPlayability({}, VIDEOS.song)).toEqual({
      kind: 'unplayable',
      status: '',
      reason: '',
    })
    expect(classifyPlayability({ playabilityStatus: { status: 'OK' } }, VIDEOS.song)).toEqual({
      kind: 'mismatch',
      videoId: undefined,
    })
  })
})

describe('the unplayable error', () => {
  it('is an FxmError with its labelled state and YouTube status', () => {
    const error = new YouTubeUnplayableError('Unavailable', 'age-restricted', {
      videoId: VIDEOS.age,
      state: 'age-restricted',
      status: 'LOGIN_REQUIRED',
      reason: 'Sign in to confirm your age',
    })
    expect(isFxmError(error, 'Unavailable')).toBe(true)
    expect(error).toBeInstanceOf(FxmError)
    expect(error.name).toBe('FxmError')
    expect(error.status).toBe('LOGIN_REQUIRED')
    expect(error.videoId).toBe(VIDEOS.age)
    expect(unavailableStateOf(error)).toBe('age-restricted')
  })

  // The shape stage 2.3's `playabilityVerdictOf` reads from an error's cause, for Smart Replace.
  it('carries a playability verdict on the video as its cause', () => {
    const age = new YouTubeUnplayableError('Unavailable', 'x', {
      videoId: VIDEOS.age,
      state: 'age-restricted',
      status: 'LOGIN_REQUIRED',
      reason: 'Sign in to confirm your age',
    })
    expect(age.cause).toEqual({
      type: 'playability',
      source: 'ytm',
      ref: VIDEOS.age,
      status: 'UNPLAYABLE',
      reason: 'Sign in to confirm your age',
    })
    const removed = new YouTubeUnplayableError('NotFound', 'x', {
      videoId: VIDEOS.kids,
      status: 'ERROR',
      reason: '',
    })
    expect(removed.cause).toEqual({
      type: 'playability',
      source: 'ytm',
      ref: VIDEOS.kids,
      status: 'ERROR',
    })
  })

  it('reads a state from errors of another copy of the module, and nothing from others', () => {
    const foreign = Object.assign(new Error('x'), { name: 'FxmError', state: 'live' })
    expect(unavailableStateOf(foreign)).toBe('live')
    expect(unavailableStateOf(Object.assign(new Error('x'), { state: 'live' }))).toBeUndefined()
    expect(unavailableStateOf(new FxmError('Unavailable', 'x'))).toBeUndefined()
    expect(unavailableStateOf({ name: 'FxmError', state: 'live' })).toBeUndefined()
    const odd = Object.assign(new Error('x'), { name: 'FxmError', state: 'toString' })
    expect(unavailableStateOf(odd)).toBeUndefined()
  })
})
