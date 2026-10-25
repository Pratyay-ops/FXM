/**
 * Test helpers for the stream resolver: the recorded `/player` fixtures, routes for the fake
 * InnerTube of `../../fixtures/testing.ts`, a fake googlevideo that answers ranged GETs the way
 * the recorded probes did, and a fake request budget.
 *
 * The fixtures next to this file are real responses recorded on 2026-10-26 from Node on a
 * residential connection, in the CORS-simple request shape, and sanitized by `sanitize.ts`.
 *
 * @module
 */

import type { AudioCandidate, TrackKind } from '@fxm/core'
import { json, type Recorded, type Route } from '../../fixtures/testing'
import type { BotCheckCause, StreamBudget, StreamRequestPriority } from '../budget'
import androidAge from './android-age.json'
import androidKids from './android-kids.json'
import androidSong from './android-song.json'
import iosSong from './ios-song.json'
import probes from './probes.json'
import visionosAge from './visionos-age.json'
import visionosBotCheck from './visionos-bot-check.json'
import visionosKids from './visionos-kids.json'
import visionosLive from './visionos-live.json'
import visionosLiveEnded from './visionos-live-ended.json'
import visionosSong from './visionos-song.json'
import visionosUpcoming from './visionos-upcoming.json'

/** The recorded `/player` responses, by file name without `.json`. */
export const PLAYER_FIXTURES = {
  'android-age': androidAge,
  'android-kids': androidKids,
  'android-song': androidSong,
  'ios-song': iosSong,
  'visionos-age': visionosAge,
  'visionos-bot-check': visionosBotCheck,
  'visionos-kids': visionosKids,
  'visionos-live': visionosLive,
  'visionos-live-ended': visionosLiveEnded,
  'visionos-song': visionosSong,
  'visionos-upcoming': visionosUpcoming,
} as const

/** The recorded googlevideo answers to ranged GETs. */
export const PROBE_FIXTURES = probes

/** The videos the fixtures are about. */
export const VIDEOS = {
  /** Radiohead's "Creep", the song (`ATV`). */
  song: 'zFYEYRcjK2g',
  /** "Baby Shark Dance", made for kids. */
  kids: 'XqZsoesa55w',
  /** An age-restricted trailer. */
  age: 'HtVdAasjOgU',
  /** A live stream. */
  live: 'rFZHOHl-L8A',
  /** A past live stream whose recording is not available. */
  liveEnded: 'jfKfPfyJRdk',
  /** A scheduled live stream that has not started. */
  upcoming: 'hv867HnY4j4',
} as const

/**
 * The length of the itag 18 file of each fixture video, from the recorded probes, by the
 * URL's `dur` parameter, which tells the videos apart: itag 18 URLs carry no `clen`.
 */
export const MUXED_LENGTHS: Readonly<Record<string, number>> = {
  '238.677': 4_757_394,
  '136.115': 7_604_777,
}

/** A `ytm` candidate for `videoId`. */
export function candidate(videoId: string, kind: TrackKind = 'song'): AudioCandidate {
  return {
    source: 'ytm',
    ref: videoId,
    kind,
    title: 'Creep',
    artists: ['Radiohead'],
    confidence: 1,
    evidence: [],
  }
}

/** The InnerTube client a recorded request was for. */
export function clientOf(request: Recorded): string | undefined {
  const context = request.body.context as { client?: { clientName?: unknown } } | undefined
  const name = context?.client?.clientName
  return typeof name === 'string' ? name : undefined
}

/** A route that answers `/player` calls for `videoId` as `client` with `body`. */
export function onPlayer(
  client: string,
  videoId: string,
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Route {
  return (request) =>
    request.url.pathname === '/youtubei/v1/player' &&
    request.body.videoId === videoId &&
    clientOf(request) === client
      ? json(body, init)
      : undefined
}

/** A route that answers the empty suggestions call that asks YouTube for a visitorData. */
export function onPriming(visitorData: string): Route {
  return (request) =>
    request.url.pathname === '/youtubei/v1/music/get_search_suggestions' &&
    request.body.input === ''
      ? json({ responseContext: { visitorData } })
      : undefined
}

/** Whether a recorded request went to googlevideo. */
export function isGoogleVideo(request: Recorded): boolean {
  return request.url.hostname.endsWith('.googlevideo.com')
}

/** Where googlevideo started refusing the recorded IOS URL. */
export const CAP_BYTES = 1_048_576

/** What a {@link fakeGoogleVideo} request asked for. */
export interface RangeRequest {
  /** The URL. */
  readonly url: URL
  /** The first byte. */
  readonly first: number
  /** The last byte. */
  readonly last: number
  /** The file's length. */
  readonly length: number
}

/** Options for {@link fakeGoogleVideo}. */
export interface FakeGoogleVideoOptions {
  /** Clients whose URLs stop at {@link CAP_BYTES}, as the IOS client's did; IOS by default. */
  readonly capped?: readonly string[]
  /** File lengths by `dur`, for URLs without `clen` (itag 18); {@link MUXED_LENGTHS}. */
  readonly lengths?: Readonly<Record<string, number>>
  /**
   * Answers a request differently: return a `Response`, throw to fail the request, or return
   * `undefined` for the usual answer.
   */
  readonly answer?: (request: RangeRequest) => Response | undefined
}

const SERVED = PROBE_FIXTURES.answers['visionos-251-end'].headers
const REFUSED = PROBE_FIXTURES.answers['ios-140-end'].headers

/**
 * A fake googlevideo, as a route of the fake InnerTube: it answers a ranged GET with 206 and
 * the requested bytes (zeros) when the URL serves its whole file, and with the recorded 403
 * when the range reaches past the cap of a capped client. Headers follow the recorded answers.
 * The file's length comes from the URL's `clen`, else from `lengths` by its `dur`.
 */
export function fakeGoogleVideo(options: FakeGoogleVideoOptions = {}): Route {
  const capped = new Set(options.capped ?? ['IOS'])
  const lengths = options.lengths ?? MUXED_LENGTHS
  return (request) => {
    if (!isGoogleVideo(request)) return undefined
    const { url } = request
    const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.get('range') ?? '')
    if (range === null) throw new Error(`An unranged googlevideo request: ${url.href}`)
    const duration = url.searchParams.get('dur') ?? ''
    const length = Number(url.searchParams.get('clen') ?? lengths[duration] ?? Number.NaN)
    if (!Number.isFinite(length)) throw new Error(`No length for ${url.href}`)
    const first = Number(range[1])
    const last = Math.min(Number(range[2]), length - 1)
    const custom = options.answer?.({ url, first, last, length })
    if (custom !== undefined) return custom
    if (capped.has(url.searchParams.get('c') ?? '') && last >= CAP_BYTES) {
      return new Response(null, { status: 403, headers: REFUSED })
    }
    const mime = url.searchParams.get('mime') ?? 'audio/webm'
    return new Response(new Uint8Array(last - first + 1), {
      status: 206,
      headers: {
        ...SERVED,
        'content-type': mime,
        'content-length': String(last - first + 1),
        'content-range': `bytes ${first}-${last}/${length}`,
      },
    })
  }
}

/** A {@link StreamBudget} that records what the resolver asks of it. */
export interface FakeStreamBudget {
  /** The budget. */
  readonly budget: StreamBudget
  /** The priority of every slot taken, in order. */
  readonly acquired: StreamRequestPriority[]
  /** Every bot check reported, in order. */
  readonly botChecks: BotCheckCause[]
}

/** A fake request budget; with `refuse`, every `acquire` rejects with it. */
export function fakeStreamBudget(refuse?: Error): FakeStreamBudget {
  const acquired: StreamRequestPriority[] = []
  const botChecks: BotCheckCause[] = []
  return {
    acquired,
    botChecks,
    budget: {
      async acquire(priority) {
        if (refuse !== undefined) throw refuse
        acquired.push(priority)
      },
      reportBotCheck(cause) {
        botChecks.push(cause)
      },
    },
  }
}
