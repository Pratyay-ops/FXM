/**
 * A stream source that resolves nothing real: it answers like the YouTube ladder (1.4) from
 * rules a test sets, and records every call.
 *
 * @module
 */

import {
  type AudioCandidate,
  type FullLengthCheck,
  type LadderRung,
  type RecoveryReason,
  type SourceId,
  type StreamOption,
  type UnplayableStatus,
  unplayableError,
} from '@fxm/core'
import type { StreamFailureReport, StreamSource, StreamSourceRequest } from '../adapters'

/** How long the fake's URLs last: 6 hours, like YouTube's. */
export const FAKE_URL_LIFETIME_MS = 6 * 60 * 60_000

/** Options for {@link ladderStreams}. */
export interface LadderStreamsOptions {
  /** Which rung: `top` gives Opus 251 and AAC 140, `fallback` the muxed itag 18. */
  rung: LadderRung
  /** What the end-of-file probe found (or `unverified` without one). */
  fullLength: FullLengthCheck
  /** Makes the URLs unique per resolution, like YouTube's signed URLs. */
  serial: number
  /** When the URLs expire, in epoch milliseconds. Leave out for URLs without expiry. */
  expiresAt?: number
  /** The URL host. Default: `media.test`. */
  host?: string
}

/**
 * Streams as the YouTube ladder returns them for `ref`: Opus 251 and AAC 140 from the top rung
 * (VISIONOS), or the muxed itag 18 from the fallback rung, at
 * `https://media.test/<ref>/<itag>?n=<serial>`.
 */
export function ladderStreams(ref: string, options: LadderStreamsOptions): StreamOption[] {
  const { rung, fullLength, serial, expiresAt, host = 'media.test' } = options
  const base = {
    protocol: 'progressive',
    ipBound: true,
    fullLength,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  } as const
  const url = (itag: number) => `https://${host}/${encodeURIComponent(ref)}/${itag}?n=${serial}`
  if (rung === 'fallback') {
    return [
      {
        ...base,
        url: url(18),
        codec: 'aac',
        container: 'mp4',
        media: 'muxed-video',
        bitrateKbps: 96,
        tier: 'normal',
      },
    ]
  }
  return [
    {
      ...base,
      url: url(251),
      codec: 'opus',
      container: 'webm',
      media: 'audio',
      bitrateKbps: 150,
      tier: 'high',
    },
    {
      ...base,
      url: url(140),
      codec: 'aac',
      container: 'm4a',
      media: 'audio',
      bitrateKbps: 130,
      tier: 'high',
    },
  ]
}

/** One call to {@link FakeStreamSource.resolve}. */
export interface FakeStreamSourceCall {
  /** The candidate. */
  candidate: AudioCandidate
  /** The request. */
  request: StreamSourceRequest
}

/** One report of a failed rung to {@link FakeStreamSource.reportFailure}. */
export interface FakeStreamSourceReport {
  /** The URL of the stream that failed. */
  url: string
  /** Why the lifecycle changes rung. */
  reason: RecoveryReason
}

/** Options for {@link FakeStreamSource}. */
export interface FakeStreamSourceOptions {
  /** The audio source. Default: `ytm`. */
  id?: SourceId
  /** Whether it has a fallback rung. Default: true for `ytm`, false otherwise. */
  hasFallback?: boolean
  /** The clock for expiry. Default: `Date.now`. */
  now?: () => number
  /** Whether the URLs expire. Default: true. */
  expires?: boolean
  /** The host of its URLs. Default: `media.test` for `ytm`, `<id>.test` otherwise. */
  host?: string
}

/**
 * A scriptable {@link StreamSource}, by default a YouTube ladder. It answers each call with
 * {@link ladderStreams} for the requested rung, probed (`verified`) where the context can read
 * media bytes and `unverified` where it cannot, like the real ladder. Rules per `ref` change
 * that: `capped` (the top rung's URLs stop early), `verdicts` (a playability verdict), `errors`
 * (any rejection; give the error a `state` for {@link stateOf}). Or replace
 * {@link FakeStreamSource.handler} altogether.
 */
export class FakeStreamSource implements StreamSource {
  readonly id: SourceId
  readonly hasFallback: boolean
  /** Every call, in order. */
  readonly calls: FakeStreamSourceCall[] = []
  /** Refs whose top-rung URLs are capped: a probe finds them `capped`, Lite gets them `unverified`. */
  readonly capped = new Set<string>()
  /** Refs the source gives a playability verdict on. */
  readonly verdicts = new Map<string, UnplayableStatus>()
  /** Refs whose resolution rejects with an error. */
  readonly errors = new Map<string, Error>()
  /** What `checkStatus` answers, by URL; `undefined` (unreadable) for others. */
  readonly statuses = new Map<string, number>()
  /** Every URL `checkStatus` was asked about. */
  readonly checked: string[] = []
  /** Every failed rung the lifecycle reported, in order. */
  readonly reports: FakeStreamSourceReport[] = []
  /**
   * Whether a `top` resolution falls through to itag 18 when the probe finds the top rung's
   * URLs capped, as the YouTube ladder (1.4) does: itag 18 first, the capped options after it.
   * `false` returns the capped options alone, so the lifecycle asks for the fallback rung itself.
   * Default: true.
   */
  fallThrough = true
  /** Answers each call. Default: the rules above. */
  handler: (candidate: AudioCandidate, request: StreamSourceRequest) => Promise<StreamOption[]>
  readonly #now: () => number
  readonly #expires: boolean
  readonly #host: string

  constructor(options: FakeStreamSourceOptions = {}) {
    this.id = options.id ?? 'ytm'
    this.hasFallback = options.hasFallback ?? this.id === 'ytm'
    this.#now = options.now ?? Date.now
    this.#expires = options.expires ?? true
    this.#host = options.host ?? (this.id === 'ytm' ? 'media.test' : `${this.id}.test`)
    this.handler = async (candidate, request) => this.answer(candidate, request)
  }

  async resolve(candidate: AudioCandidate, request: StreamSourceRequest): Promise<StreamOption[]> {
    this.calls.push({ candidate, request })
    return this.handler(candidate, request)
  }

  /** The muxed itag 18 is the fallback rung's; everything else is the top rung's. */
  rungOf(option: StreamOption): LadderRung {
    return option.media === 'muxed-video' ? 'fallback' : 'top'
  }

  reportFailure(stream: StreamOption, report: StreamFailureReport): void {
    this.reports.push({ url: stream.url, reason: report.recovery.reason })
  }

  /** The `state` an error carries, like the YouTube ladder's `YouTubeUnplayableError`. */
  stateOf(error: unknown): string | undefined {
    const state = typeof error === 'object' && error !== null ? Reflect.get(error, 'state') : null
    return typeof state === 'string' ? state : undefined
  }

  async checkStatus(stream: StreamOption): Promise<number | undefined> {
    this.checked.push(stream.url)
    return this.statuses.get(stream.url)
  }

  /** What the default handler answers: the rules, then {@link ladderStreams}. */
  answer(candidate: AudioCandidate, request: StreamSourceRequest): StreamOption[] {
    const { ref } = candidate
    const error = this.errors.get(ref)
    if (error !== undefined) throw error
    const status = this.verdicts.get(ref)
    if (status !== undefined) throw unplayableError({ source: this.id, ref, status })
    const readable = request.ctx.capabilities.mediaBytes
    const rung = this.hasFallback ? request.rung : 'top'
    const streams = (rungToBuild: LadderRung, fullLength: FullLengthCheck) =>
      ladderStreams(ref, {
        rung: rungToBuild,
        fullLength,
        serial: this.calls.length,
        ...(this.#expires ? { expiresAt: this.#now() + FAKE_URL_LIFETIME_MS } : {}),
        host: this.#host,
      })
    if (!readable) return streams(rung, 'unverified')
    if (rung === 'fallback' || !this.capped.has(ref)) return streams(rung, 'verified')
    const capped = streams('top', 'capped')
    if (!this.fallThrough || !this.hasFallback) return capped
    return [...streams('fallback', 'verified'), ...capped]
  }

  /** Each call as `<ref>:<rung>`, e.g. `abc:fallback`, in order. */
  get log(): string[] {
    return this.calls.map(({ candidate, request }) => `${candidate.ref}:${request.rung}`)
  }

  /** How many calls resolved `ref`. */
  callsFor(ref: string): number {
    return this.calls.filter(({ candidate }) => candidate.ref === ref).length
  }
}
