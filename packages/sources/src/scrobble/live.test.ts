/**
 * Live checks against ListenBrainz and Last.fm. They run only with `FXM_LIVE=1`:
 *
 * ```sh
 * FXM_LIVE=1 scripts/run.sh pnpm exec vitest run packages/sources/src/scrobble/live.test.ts
 * ```
 *
 * Without credentials they make five requests, all with made-up credentials, so they write
 * nothing anywhere: the services' answers to them, and their CORS headers.
 *
 * With credentials of your own in the environment (never commit them), they also check them,
 * and announce a track as playing now, which shows on the profile for a few minutes and adds
 * nothing to its history. They never submit a listen:
 *
 * - `FXM_LISTENBRAINZ_TOKEN`: validates the token and sends a playing-now listen;
 * - `FXM_LASTFM_API_KEY` and `FXM_LASTFM_SECRET`: get a request token;
 * - with `FXM_LASTFM_SESSION_KEY` as well: `track.updateNowPlaying`.
 */

import { describe, expect, it } from 'vitest'
import { ScrobbleError } from './errors'
import { contextFor, LASTFM_TEST_CREDENTIALS, LISTENBRAINZ_TEST_TOKEN } from './fixtures/testing'
import { LASTFM_API_URL, LastfmScrobbleClient } from './lastfm'
import { LISTENBRAINZ_API_URL, ListenBrainzScrobbleClient } from './listenbrainz'
import type { ScrobbleTrack } from './types'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const live = env?.FXM_LIVE === '1'

/** The web app's origin, which the services see on its requests. */
const ORIGIN = 'https://fxmusic.pages.dev'

const ctx = contextFor(globalThis.fetch.bind(globalThis))

const TRACK: ScrobbleTrack = {
  artists: ['Radiohead'],
  title: 'Creep',
  album: 'Pablo Honey',
  durationMs: 238_640,
}

describe.skipIf(!live)('ListenBrainz, live', { timeout: 30_000 }, () => {
  it('lets any web page send the token and JSON', async () => {
    const preflight = await fetch(`${LISTENBRAINZ_API_URL}1/submit-listens`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    })
    await preflight.body?.cancel()
    expect(preflight.ok).toBe(true)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/\bauthorization\b/i)
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/\bcontent-type\b/i)
  })

  it('says a made-up token is not valid, with CORS and rate-limit headers', async () => {
    const response = await fetch(`${LISTENBRAINZ_API_URL}1/validate-token`, {
      headers: { Origin: ORIGIN, Authorization: `Token ${LISTENBRAINZ_TEST_TOKEN}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-expose-headers')).toMatch(/X-RateLimit-Reset-In/i)
    expect(await response.json()).toMatchObject({ valid: false })
    const client = new ListenBrainzScrobbleClient(LISTENBRAINZ_TEST_TOKEN)
    expect(await client.validateToken(ctx)).toEqual({ valid: false })
  })

  it.skipIf(env?.FXM_LISTENBRAINZ_TOKEN === undefined)(
    'validates a real token and announces a track as playing now',
    async () => {
      const client = new ListenBrainzScrobbleClient(env?.FXM_LISTENBRAINZ_TOKEN ?? '')
      const check = await client.validateToken(ctx)
      expect(check.valid).toBe(true)
      await client.playingNow(TRACK, ctx)
    },
  )
})

describe.skipIf(!live)('Last.fm, live', { timeout: 30_000 }, () => {
  it('refuses a made-up API key, and lets any web page read the answer', async () => {
    const response = await fetch(LASTFM_API_URL, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: new URLSearchParams({
        method: 'auth.getToken',
        api_key: LASTFM_TEST_CREDENTIALS.apiKey,
        api_sig: LASTFM_TEST_CREDENTIALS.secret,
        format: 'json',
      }),
    })
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toMatchObject({ error: 10 })
    const client = new LastfmScrobbleClient(LASTFM_TEST_CREDENTIALS)
    const error = await client.getToken(ctx).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ScrobbleError)
    expect(error).toMatchObject({ failure: 'refused', serviceCode: 10 })
  })

  const apiKey = env?.FXM_LASTFM_API_KEY
  const secret = env?.FXM_LASTFM_SECRET
  const sessionKey = env?.FXM_LASTFM_SESSION_KEY

  it.skipIf(apiKey === undefined || secret === undefined)(
    'gets a request token with a real API account',
    async () => {
      const client = new LastfmScrobbleClient({ apiKey: apiKey ?? '', secret: secret ?? '' })
      expect(await client.getToken(ctx)).toMatch(/^[0-9a-f]{32}$/i)
    },
  )

  it.skipIf(apiKey === undefined || secret === undefined || sessionKey === undefined)(
    'announces a track as playing now',
    async () => {
      const client = new LastfmScrobbleClient({ apiKey: apiKey ?? '', secret: secret ?? '' })
      await client.updateNowPlaying(sessionKey ?? '', TRACK, ctx)
    },
  )
})
