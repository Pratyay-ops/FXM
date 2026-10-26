import { describe, expect, it } from 'vitest'
import { context, FULL, fakeInnerTube, onSwJsData, type Route } from '../../fixtures/testing'
import { createYouTubeSession } from '../../session'
import { PLAYER_RECORDINGS, recordPlayers, recordProbes } from './record'
import { clientOf, fakeGoogleVideo, onPlayer, PLAYER_FIXTURES, PROBE_FIXTURES } from './testing'

const CLIENTS: Readonly<Record<string, string>> = {
  visionos: 'VISIONOS',
  'android-muxed': 'ANDROID',
  ios: 'IOS',
}

/** Answers the call without a visitorData with the recorded bot check. */
const unsessioned: Route = (request) =>
  request.url.pathname === '/youtubei/v1/player' &&
  clientOf(request) === 'VISIONOS' &&
  !(request.rawBody ?? '').includes('visitorData')
    ? new Response(JSON.stringify(PLAYER_FIXTURES['visionos-bot-check']))
    : undefined

describe('the fixture recorder, replayed offline', () => {
  const routes = PLAYER_RECORDINGS.filter((recording) => !recording.withoutVisitorData).map(
    (recording) =>
      onPlayer(
        CLIENTS[recording.rung] ?? '',
        recording.videoId,
        PLAYER_FIXTURES[recording.name as keyof typeof PLAYER_FIXTURES],
      ),
  )
  const fake = fakeInnerTube(onSwJsData(), unsessioned, ...routes, fakeGoogleVideo())
  const ctx = context(fake.fetch, { capabilities: FULL })

  it('records every /player fixture as it is', async () => {
    const { sanitized } = await recordPlayers(ctx, createYouTubeSession())
    expect(sanitized).toEqual(PLAYER_FIXTURES)
  })

  it('records the probes the fixtures hold', async () => {
    const { raw } = await recordPlayers(ctx, createYouTubeSession())
    const answers = await recordProbes(ctx, raw)
    const expected = PROBE_FIXTURES.answers as Record<string, Record<string, unknown>>
    expect(Object.keys(answers)).toEqual(Object.keys(expected))
    for (const [name, answer] of Object.entries(answers)) {
      const { client, itag, range, status, bytes, headers } = expected[name] ?? {}
      expect(answer, name).toMatchObject({ client, itag, range, status, bytes })
      const contentRange = (headers as Record<string, string>)['content-range']
      if (contentRange !== undefined) {
        expect((answer as { headers: Record<string, string> }).headers['content-range']).toBe(
          contentRange,
        )
      }
    }
  })
})
