/**
 * What the stream fixtures are recordings of, and how to record them: each `/player` call the
 * resolver makes, in its own request shape, and googlevideo's answers to the ranged GETs of the
 * probe. `record.live.test.ts` runs this against YouTube; `record.test.ts` runs it against the
 * fixtures themselves, which must come back unchanged.
 *
 * @module
 */

import type { ProviderContext } from '@fxm/core'
import { at } from '../../json'
import type { YouTubeSession } from '../../session'
import { UNMETERED_STREAM_BUDGET } from '../budget'
import { BUNDLED_STREAM_CONFIG, type StreamClientConfig } from '../config'
import { callPlayer, playerRequest } from '../player'
import { sanitizePlayerResponse } from './sanitize'
import { VIDEOS } from './testing'

/** One recorded `/player` call. */
export interface PlayerRecording {
  /** The fixture's file name, without `.json`. */
  readonly name: string
  /** The rung whose client makes the call. */
  readonly rung: string
  /** The video. */
  readonly videoId: string
  /** Sent without a visitorData, as a Lite session's first call would be without priming. */
  readonly withoutVisitorData?: boolean
}

/**
 * The `/player` fixtures. The live stream, the past one and the scheduled one change over
 * time: before recording again, check that `VIDEOS.live` is still live and `VIDEOS.upcoming`
 * still scheduled, or pick new ones.
 */
export const PLAYER_RECORDINGS: readonly PlayerRecording[] = [
  { name: 'visionos-song', rung: 'visionos', videoId: VIDEOS.song },
  { name: 'android-song', rung: 'android-muxed', videoId: VIDEOS.song },
  { name: 'ios-song', rung: 'ios', videoId: VIDEOS.song },
  { name: 'visionos-bot-check', rung: 'visionos', videoId: VIDEOS.song, withoutVisitorData: true },
  { name: 'visionos-kids', rung: 'visionos', videoId: VIDEOS.kids },
  { name: 'android-kids', rung: 'android-muxed', videoId: VIDEOS.kids },
  { name: 'visionos-age', rung: 'visionos', videoId: VIDEOS.age },
  { name: 'android-age', rung: 'android-muxed', videoId: VIDEOS.age },
  { name: 'visionos-live', rung: 'visionos', videoId: VIDEOS.live },
  { name: 'visionos-live-ended', rung: 'visionos', videoId: VIDEOS.liveEnded },
  { name: 'visionos-upcoming', rung: 'visionos', videoId: VIDEOS.upcoming },
]

function clientOf(rung: string): StreamClientConfig {
  const found = BUNDLED_STREAM_CONFIG.rungs.find((entry) => entry.id === rung)
  if (found === undefined) throw new Error(`No rung ${rung} in the bundled config`)
  return found.client
}

/** A `/player` call without a visitorData: what VISIONOS answers with a bot check. */
async function withoutVisitorData(
  ctx: ProviderContext,
  session: YouTubeSession,
  recording: PlayerRecording,
): Promise<unknown> {
  const request = playerRequest(clientOf(recording.rung), recording.videoId, { session })
  const response = await ctx.fetch(request.url, request.init)
  return JSON.parse(await response.text()) as unknown
}

/** Recorded `/player` responses by fixture name: as YouTube sent them, and sanitized. */
export interface RecordedPlayers {
  /** As YouTube sent them, with the machine's details: never write these to disk. */
  readonly raw: Record<string, unknown>
  /** Sanitized, as the fixtures hold them. */
  readonly sanitized: Record<string, unknown>
}

/** Records every `/player` fixture. */
export async function recordPlayers(
  ctx: ProviderContext,
  session: YouTubeSession,
): Promise<RecordedPlayers> {
  const raw: Record<string, unknown> = {}
  const sanitized: Record<string, unknown> = {}
  for (const recording of PLAYER_RECORDINGS) {
    let json: unknown
    if (recording.withoutVisitorData) {
      json = await withoutVisitorData(ctx, session, recording)
    } else {
      const answer = await callPlayer(ctx, clientOf(recording.rung), recording.videoId, {
        session,
        budget: UNMETERED_STREAM_BUDGET,
        priority: 'interactive',
        timeoutMs: 20_000,
      })
      if ('botCheck' in answer) throw new Error(`A bot check: ${answer.botCheck}`)
      json = answer.json
    }
    raw[recording.name] = json
    sanitized[recording.name] = sanitizePlayerResponse(json)
  }
  return { raw, sanitized }
}

/** The headers of googlevideo's answers that the fixtures keep. */
const KEPT_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'cross-origin-resource-policy',
  'x-content-type-options',
  'server',
  'last-modified',
]

/** One ranged GET the probe fixtures keep. */
interface ProbeRecording {
  readonly name: string
  readonly player: string
  readonly itag: number
  /** The range: from the start, past the 1 MiB cap, or the last 64 KiB. */
  readonly at: 'start' | 'past-1MiB' | 'end'
}

const PROBE_RECORDINGS: readonly ProbeRecording[] = [
  { name: 'visionos-251-end', player: 'visionos-song', itag: 251, at: 'end' },
  { name: 'visionos-140-end', player: 'visionos-song', itag: 140, at: 'end' },
  { name: 'android-18-start', player: 'android-song', itag: 18, at: 'start' },
  { name: 'android-18-end', player: 'android-song', itag: 18, at: 'end' },
  { name: 'android-kids-18-end', player: 'android-kids', itag: 18, at: 'end' },
  { name: 'ios-140-start', player: 'ios-song', itag: 140, at: 'start' },
  { name: 'ios-140-past-1MiB', player: 'ios-song', itag: 140, at: 'past-1MiB' },
  { name: 'ios-140-end', player: 'ios-song', itag: 140, at: 'end' },
]

/** The URL of a format in a raw `/player` response. */
function urlOf(response: unknown, itag: number): string {
  for (const list of ['formats', 'adaptiveFormats']) {
    for (const format of (at(response, 'streamingData', list) as unknown[] | undefined) ?? []) {
      const url = at(format, 'url')
      if (at(format, 'itag') === itag && typeof url === 'string') return url
    }
  }
  throw new Error(`No URL for itag ${itag}`)
}

async function ranged(ctx: ProviderContext, url: string, first: number, last: number) {
  const response = await ctx.fetch(url, {
    headers: { Range: `bytes=${first}-${last}` },
    credentials: 'omit',
  })
  const bytes = (await response.arrayBuffer()).byteLength
  const headers = Object.fromEntries(
    KEPT_HEADERS.flatMap((name) => {
      const value = response.headers.get(name)
      return value === null ? [] : [[name, value]]
    }),
  )
  return { status: response.status, headers, bytes }
}

/**
 * Records googlevideo's answers to ranged GETs of URLs from the raw `/player` responses, by
 * name, in the form of `probes.json`. A file's length comes from its first byte's
 * `Content-Range`.
 */
export async function recordProbes(
  ctx: ProviderContext,
  players: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const answers: Record<string, unknown> = {}
  for (const probe of PROBE_RECORDINGS) {
    const url = urlOf(players[probe.player], probe.itag)
    const head = await ranged(ctx, url, 0, 0)
    const length = Number(/\/(\d+)$/u.exec(String(head.headers['content-range']))?.[1])
    const [first, last] =
      probe.at === 'start'
        ? [0, probe.itag === 18 ? 262_143 : 65_535]
        : probe.at === 'past-1MiB'
          ? [1_048_576, 1_048_576 + 65_535]
          : [length - 65_536, length - 1]
    answers[probe.name] = {
      client: new URL(url).searchParams.get('c'),
      itag: probe.itag,
      range: `bytes=${first}-${last}`,
      ...(await ranged(ctx, url, first, last)),
    }
  }
  return answers
}
