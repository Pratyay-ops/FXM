/**
 * The test page's script (`/harness.html` on the FXM origin): the platform package as the web
 * app will use it, with the real sandbox transport, exposed as `window.fxmHarness` for the
 * Playwright tests. `network.ts` bundles it for the browser.
 *
 * @module
 */

import { DEFAULT_QUALITY_PREFS, pickStream, type StreamOption } from '@fxm/core'
import { createYouTubeAudioSource, createYouTubeProviders } from '@fxm/sources/youtube'
import { createPlatform, type FxmPlatform } from '../../../platform'
import { memoryStorage } from '../../../storage'
import { SANDBOX_MESSAGE, SANDBOX_PROTOCOL } from '../../document'
import {
  type BrowserSandboxTransport,
  createSandboxTransport,
  type SandboxDocumentOptions,
  type SandboxTransportOptions,
} from '../../transport'

/** How a call ended, in a form `page.evaluate` can return. */
export type Outcome =
  | {
      readonly ok: true
      readonly status: number
      readonly statusText: string
      readonly url: string
      readonly headers: Record<string, string>
      readonly text: string
    }
  | { readonly ok: false; readonly error: ErrorSummary }

/** An error, in a form `page.evaluate` can return. */
export interface ErrorSummary {
  readonly name: string
  readonly message: string
  readonly code?: string
  readonly reason?: string
  readonly sandboxCode?: string
}

/** Options for {@link Harness.start}. */
export interface StartOptions {
  /** The Lite kill switch at start. */
  readonly killed?: boolean
  /** Hosts the user added in Settings. */
  readonly userHosts?: readonly string[]
  readonly innerTube?: SandboxDocumentOptions
  readonly userHost?: SandboxDocumentOptions
}

/** A rung of the test ladder: a `/player` call with one client, then one of its URLs. */
export interface Rung {
  /** For the record, e.g. `VISIONOS`. */
  readonly name: string
  /** The `/player` URL. */
  readonly url: string
  /** `context.client`. */
  readonly client: Record<string, unknown>
  /** Which URL to play: the best audio-only format, or the muxed itag 18. */
  readonly pick: 'audio' | 'itag18'
}

/** What happened on one rung. */
export interface RungResult {
  readonly name: string
  readonly status?: number
  readonly playability?: string
  readonly title?: string
  readonly lengthSeconds?: number
  readonly itag?: number
  readonly mimeType?: string
  /** `playing`, `ended`, `error <MediaError code>`, `stalled` or why there was nothing to play. */
  readonly outcome: string
  /** Milliseconds from setting `src` to the outcome. */
  readonly ms?: number
  /** Where playback was when the harness stopped watching, in seconds. */
  readonly currentTime?: number
  /** The media's duration as the element saw it, in seconds. */
  readonly duration?: number
}

/** Options for {@link Harness.resolveAndPlay}. */
export interface PlayOptions {
  readonly videoId: string
  readonly ladder: readonly Rung[]
  /** How long a rung may take to reach `playing`. */
  readonly stallMs: number
  /** How long to let it play once it does, or `'end'` to wait for `ended`. */
  readonly playMs: number | 'end'
}

/** Options for {@link Harness.playSong}. */
export interface SongOptions {
  /** What to search YouTube Music for: the first song found plays. */
  readonly query: string
  /** How long the stream may take to reach `playing`, and the longest stall after that. */
  readonly stallMs: number
  /** How long to let it play once it does, or `'end'` to wait for `ended`. */
  readonly playMs: number | 'end'
}

/**
 * What {@link Harness.playSong} found and played. No URL, visitorData or other identifier: the
 * record is printed and attached to the test report.
 */
export interface SongResult {
  /** How many songs the search found on its first page. */
  readonly songs: number
  readonly title?: string
  readonly durationMs?: number
  /** How many stream options the resolver returned. */
  readonly options?: number
  /** The option played: its rung, itag, label and probe state. */
  readonly rung?: string
  readonly itag?: number
  readonly label?: string
  readonly fullLength?: string
  /** Whether the YouTube session holds a visitorData YouTube issued: `issued` or `none`. */
  readonly visitorData: 'issued' | 'none'
  /** `playing`, `ended`, `error <code>`, `stalled`, or why nothing played. */
  readonly outcome: string
  readonly ms?: number
  readonly currentTime?: number
  readonly duration?: number
}

const state: {
  platform?: FxmPlatform | undefined
  sandbox?: BrowserSandboxTransport
  later?: Promise<Outcome>
  killed: boolean
} = { killed: false }

function summarize(error: unknown): ErrorSummary {
  const fields = (typeof error === 'object' && error !== null ? error : {}) as Record<
    string,
    unknown
  >
  return {
    name: typeof fields.name === 'string' ? fields.name : 'Error',
    message: typeof fields.message === 'string' ? fields.message : String(error),
    ...(typeof fields.code === 'string' ? { code: fields.code } : {}),
    ...(typeof fields.reason === 'string' ? { reason: fields.reason } : {}),
    ...(typeof fields.sandboxCode === 'string' ? { sandboxCode: fields.sandboxCode } : {}),
  }
}

async function outcome(call: () => Promise<Response>): Promise<Outcome> {
  try {
    const response = await call()
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: Object.fromEntries(response.headers),
      text: await response.text(),
    }
  } catch (error) {
    return { ok: false, error: summarize(error) }
  }
}

function platform(): FxmPlatform {
  if (state.platform === undefined) throw new Error('Call fxmHarness.start() first')
  return state.platform
}

function sandbox(): BrowserSandboxTransport {
  if (state.sandbox === undefined) throw new Error('Call fxmHarness.start() first')
  return state.sandbox
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A token like the transport's: 128 random bits in hexadecimal. */
function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

/** A request in the CORS-simple shape the sandbox takes, in any shape the test asks for. */
function sandboxRequest(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) {
  return {
    url,
    init: { credentials: 'omit', headers: {}, ...init },
  } as unknown as Parameters<BrowserSandboxTransport['innerTube']>[0]
}

/** The URL to play from a `/player` answer, and what it is. */
function pickFormat(
  answer: Record<string, unknown>,
  pick: Rung['pick'],
): { url: string; itag: number; mimeType: string } | undefined {
  const streaming = (answer.streamingData ?? {}) as {
    formats?: { itag?: number; url?: string; mimeType?: string }[]
    adaptiveFormats?: { itag?: number; url?: string; mimeType?: string }[]
  }
  const usable = (formats: typeof streaming.formats = []) =>
    formats.filter(
      (format): format is { itag: number; url: string; mimeType: string } =>
        typeof format.itag === 'number' &&
        typeof format.url === 'string' &&
        typeof format.mimeType === 'string',
    )
  if (pick === 'itag18') return usable(streaming.formats).find((format) => format.itag === 18)
  const probe = document.createElement('audio')
  // Opus 251, then AAC 140, as the resolver prefers them, where this browser plays them.
  for (const itag of [251, 140, 250, 249, 139]) {
    const format = usable(streaming.adaptiveFormats).find((candidate) => candidate.itag === itag)
    if (format !== undefined && probe.canPlayType(format.mimeType) !== '') return format
  }
  return undefined
}

/** The MIME type `canPlayType` gets for a stream option, from its codec, container and media. */
function mimeTypeOf(option: StreamOption): string {
  if (option.media === 'muxed-video') return 'video/mp4; codecs="avc1.42001E, mp4a.40.2"'
  if (option.codec === 'opus') return `audio/${option.container}; codecs="opus"`
  if (option.codec === 'aac') return 'audio/mp4; codecs="mp4a.40.2"'
  return `audio/${option.container}`
}

/**
 * Plays `url` in `audio`: resolves `playing` once it plays (or, `untilEnd`, `ended` once it
 * ends), `error <code>` on a media error, and `stalled` when it makes no progress for `stallMs`.
 */
function play(audio: HTMLAudioElement, url: string, stallMs: number, untilEnd: boolean) {
  return new Promise<string>((resolve) => {
    let timer = setTimeout(() => finish('stalled'), stallMs)
    const progress = () => {
      clearTimeout(timer)
      timer = setTimeout(() => finish('stalled mid-way'), stallMs)
    }
    const onPlaying = () => (untilEnd ? progress() : finish('playing'))
    const onTimeUpdate = () => {
      if (untilEnd) progress()
    }
    const onEnded = () => finish('ended')
    const onError = () => finish(`error ${audio.error?.code ?? '?'}`)
    function finish(result: string) {
      clearTimeout(timer)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      resolve(result)
    }
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    audio.src = url
    audio.play().catch(() => undefined)
  })
}

/** A muted `<audio>` for one test, removed afterwards. */
async function withAudio<T>(use: (audio: HTMLAudioElement) => Promise<T>): Promise<T> {
  const audio = document.createElement('audio')
  audio.muted = true
  audio.preload = 'auto'
  document.body.append(audio)
  try {
    return await use(audio)
  } finally {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    audio.remove()
  }
}

const harness = {
  /**
   * Creates the platform with the real sandbox transport, waits for the Lite self-test, and
   * resolves with the capabilities.
   */
  async start(options: StartOptions = {}) {
    state.platform?.dispose()
    state.sandbox?.dispose()
    state.killed = options.killed ?? false
    const transport = createSandboxTransport({
      ...(options.innerTube === undefined ? {} : { innerTube: options.innerTube }),
      ...(options.userHost === undefined ? {} : { userHost: options.userHost }),
    })
    state.sandbox = transport
    state.platform = await createPlatform({
      environment: 'browser',
      sandbox: transport,
      storage: memoryStorage(),
      killSwitches: () => ({ lite: state.killed }),
      userHosts: () => options.userHosts ?? [],
    })
    // `createPlatform` resolves before the self-test, a round trip to YouTube, is done.
    return state.platform.capabilities.refresh()
  },

  /** Creates only a sandbox transport, without a platform. */
  sandboxOnly(options: SandboxTransportOptions = {}) {
    state.platform?.dispose()
    state.sandbox?.dispose()
    state.platform = undefined
    state.sandbox = createSandboxTransport(options)
  },

  /** Sets the Lite kill switch, as a new remote config would. */
  setKilled(killed: boolean) {
    state.killed = killed
  },

  /** Detects the capabilities again. */
  refresh() {
    return platform().capabilities.refresh()
  },

  /** Runs the self-test again, as Settings → Diagnostics will, then detects again. */
  async retest() {
    await platform().lite?.check({ force: true })
    return platform().capabilities.refresh()
  },

  liteReady() {
    return platform().lite?.ready ?? false
  },

  liteState() {
    return platform().lite?.state
  },

  budget() {
    return platform().budget.snapshot()
  },

  frames() {
    return [...document.querySelectorAll('iframe')].map((frame) => ({
      src: frame.src.split('#')[0],
      token: /^[0-9a-f]{32}$/.test(frame.src.split('#')[1] ?? ''),
      sandbox: frame.getAttribute('sandbox'),
      hidden: frame.hidden,
    }))
  },

  /** A request through the platform's `fetch`, as a provider makes it. */
  fetch(url: string, init: RequestInit = {}) {
    return outcome(() => platform().transport.fetch(url, init))
  },

  /** A request straight to the sandbox transport, in any shape. */
  innerTube(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ) {
    return outcome(() => sandbox().innerTube(sandboxRequest(url, init)))
  },

  /** Starts {@link harness.innerTube} without waiting; {@link harness.settled} waits for it. */
  innerTubeLater(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ) {
    state.later = outcome(() => sandbox().innerTube(sandboxRequest(url, init)))
  },

  /** The outcome of the request {@link harness.innerTubeLater} started. */
  settled() {
    if (state.later === undefined) throw new Error('Call fxmHarness.innerTubeLater() first')
    return state.later
  },

  /** A request from this page itself, which has a named origin. */
  pageFetch(url: string, init: RequestInit = {}) {
    return outcome(() => fetch(url, { credentials: 'omit', ...init }))
  },

  /**
   * Frames a sandbox document by hand with a token, connects to it as the transport would, and
   * sends it messages the transport would never send, to check the document's own checks.
   */
  async raw(path: string, messages: readonly Record<string, unknown>[], waitMs = 3000) {
    const token = randomToken()
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.hidden = true
    const hello = new Promise<{ origin: string; data: unknown }>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow) return
        removeEventListener('message', onMessage)
        resolve({ origin: event.origin, data: event.data })
      }
      addEventListener('message', onMessage)
    })
    frame.src = `${path}#${token}`
    document.body.append(frame)
    const greeting = await hello
    const channel = new MessageChannel()
    const received: unknown[] = []
    channel.port1.onmessage = (event) => {
      const data = event.data as Record<string, unknown>
      received.push(
        data.body instanceof ArrayBuffer
          ? { ...data, body: new TextDecoder().decode(data.body) }
          : data,
      )
    }
    frame.contentWindow?.postMessage(
      { type: SANDBOX_MESSAGE.connect, protocol: SANDBOX_PROTOCOL },
      '*',
      [channel.port2],
    )
    for (let waited = 0; received.length === 0 && waited < waitMs; waited += 50) await delay(50)
    for (const message of messages) {
      channel.port1.postMessage({ type: SANDBOX_MESSAGE.request, ...message })
    }
    const deadline = Date.now() + waitMs
    while (received.length < messages.length + 1 && Date.now() < deadline) await delay(50)
    channel.port1.close()
    frame.remove()
    const [ready, ...replies] = received
    return { hello: greeting, token, ready, replies }
  },

  /**
   * The test ladder as stage 2.3 will run it in Lite: a `/player` call through the sandbox per
   * rung, then the rung's URL in `<audio>`, where a media error or a stall before `playing`
   * counts as a failed probe and moves on to the next rung.
   */
  resolveAndPlay(options: PlayOptions): Promise<RungResult[]> {
    return withAudio(async (audio) => {
      const results: RungResult[] = []
      const fetchPlayer = platform().transport.withPriority('current-track')
      for (const rung of options.ladder) {
        const answer = await outcome(() =>
          fetchPlayer(rung.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              context: { client: rung.client },
              videoId: options.videoId,
              contentCheckOk: true,
              racyCheckOk: true,
            }),
          }),
        )
        if (!answer.ok) {
          results.push({ name: rung.name, outcome: `player failed: ${answer.error.message}` })
          continue
        }
        const json = JSON.parse(answer.text) as Record<string, unknown>
        const details = (json.videoDetails ?? {}) as { title?: string; lengthSeconds?: string }
        const playability = (json.playabilityStatus as { status?: string } | undefined)?.status
        const base = {
          name: rung.name,
          status: answer.status,
          ...(playability === undefined ? {} : { playability }),
          ...(details.title === undefined ? {} : { title: details.title }),
          ...(details.lengthSeconds === undefined
            ? {}
            : { lengthSeconds: Number(details.lengthSeconds) }),
        }
        const format = pickFormat(json, rung.pick)
        if (format === undefined) {
          results.push({ ...base, outcome: 'no playable format' })
          continue
        }
        const started = performance.now()
        const result = await play(audio, format.url, options.stallMs, options.playMs === 'end')
        const ms = Math.round(performance.now() - started)
        if (result === 'playing' && typeof options.playMs === 'number') {
          await delay(options.playMs)
        }
        results.push({
          ...base,
          itag: format.itag,
          mimeType: format.mimeType,
          outcome: result,
          ms,
          currentTime: audio.currentTime,
          duration: audio.duration,
        })
        if (result === 'playing' || result === 'ended') break
      }
      return results
    })
  },

  /**
   * One song as the app will play it in Lite: a YouTube Music search with stage 1.3's provider,
   * then stage 1.4's stream resolver (its `/player` request and its formats) and core's
   * `pickStream` among the options this browser plays, all through the platform's `fetch` and so
   * through the sandbox; then the stream in `<audio>`.
   */
  playSong(options: SongOptions): Promise<SongResult> {
    return withAudio(async (audio) => {
      const current = platform()
      const { session, music } = createYouTubeProviders()
      const source = createYouTubeAudioSource({ session })
      const interactive = current.context({ mode: 'music', priority: 'interactive' })
      const found = await music.search(options.query, { types: ['track'], limit: 5 }, interactive)
      const songs = found.tracks?.items ?? []
      const visitorData = (): SongResult['visitorData'] =>
        session.visitorData.current === undefined ? 'none' : 'issued'
      const [song] = songs
      if (song === undefined) return { songs: 0, visitorData: visitorData(), outcome: 'no song' }
      const about = {
        songs: songs.length,
        title: song.title,
        ...(song.durationMs === undefined ? {} : { durationMs: song.durationMs }),
      }
      const playback = current.context({ mode: 'music', priority: 'current-track' })
      const [candidate] = await source.match(song, playback)
      if (candidate === undefined) {
        return { ...about, visitorData: visitorData(), outcome: 'no candidate' }
      }
      const streams = await source.resolve(candidate, playback, DEFAULT_QUALITY_PREFS)
      const playable = streams.filter((option) => audio.canPlayType(mimeTypeOf(option)) !== '')
      const stream = pickStream(playable, DEFAULT_QUALITY_PREFS.streaming.wifi)
      const resolved = { ...about, options: streams.length, visitorData: visitorData() }
      if (stream === undefined) return { ...resolved, outcome: 'nothing this browser plays' }
      const started = performance.now()
      const result = await play(audio, stream.url, options.stallMs, options.playMs === 'end')
      const ms = Math.round(performance.now() - started)
      if (result === 'playing' || result === 'ended') source.reportPlaybackSuccess(stream, playback)
      if (result === 'playing' && typeof options.playMs === 'number') await delay(options.playMs)
      return {
        ...resolved,
        rung: stream.rung,
        itag: stream.itag,
        label: stream.label,
        fullLength: stream.fullLength,
        outcome: result,
        ms,
        currentTime: audio.currentTime,
        duration: audio.duration,
      }
    })
  },
}

declare global {
  interface Window {
    fxmHarness: typeof harness
  }
}

window.fxmHarness = harness
