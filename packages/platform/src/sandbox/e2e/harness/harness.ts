/**
 * The test page's script (`/harness.html` on the FXM origin): the platform package as the web
 * app will use it, with the real sandbox transport, exposed as `window.fxmHarness` for the
 * Playwright tests. `network.ts` bundles it for the browser.
 *
 * @module
 */

import { createPlatform, type FxmPlatform } from '../../../platform'
import { memoryStorage } from '../../../storage'
import { SANDBOX_MESSAGE, SANDBOX_PROTOCOL } from '../../document'
import {
  type BrowserSandboxTransport,
  createSandboxTransport,
  type SandboxDocumentOptions,
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

/** A rung of the stream ladder: a `/player` call with one client, then one of its URLs. */
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
  readonly visitorData?: string
  readonly ladder: readonly Rung[]
  /** How long a rung may take to reach `playing`. */
  readonly stallMs: number
  /** How long to let it play once it does, or `'end'` to wait for `ended`. */
  readonly playMs: number | 'end'
}

const state: {
  platform?: FxmPlatform
  sandbox?: BrowserSandboxTransport
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

const harness = {
  /** Creates the platform with the real sandbox transport and resolves with the capabilities. */
  async start(options: StartOptions = {}) {
    state.platform?.dispose()
    state.sandbox?.dispose()
    state.killed = options.killed ?? false
    const sandbox = createSandboxTransport({
      ...(options.innerTube === undefined ? {} : { innerTube: options.innerTube }),
      ...(options.userHost === undefined ? {} : { userHost: options.userHost }),
    })
    state.sandbox = sandbox
    state.platform = await createPlatform({
      environment: 'browser',
      sandbox,
      storage: memoryStorage(),
      killSwitches: () => ({ lite: state.killed }),
      userHosts: () => options.userHosts ?? [],
    })
    return state.platform.capabilities.current
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

  budget() {
    return platform().budget.snapshot()
  },

  frames() {
    return [...document.querySelectorAll('iframe')].map((frame) => ({
      src: frame.src,
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
    const request = {
      url,
      init: { credentials: 'omit', headers: {}, ...init },
    } as unknown as Parameters<BrowserSandboxTransport['innerTube']>[0]
    return outcome(() => (state.sandbox as BrowserSandboxTransport).innerTube(request))
  },

  /** A request from this page itself, which has a named origin. */
  pageFetch(url: string, init: RequestInit = {}) {
    return outcome(() => fetch(url, { credentials: 'omit', ...init }))
  },

  /**
   * Frames a sandbox document by hand, connects to it as the transport would and sends it
   * messages the transport would never send, to check the document's own checks.
   */
  async raw(path: string, messages: readonly Record<string, unknown>[], waitMs = 3000) {
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
    frame.src = path
    document.body.append(frame)
    const greeting = await hello
    const channel = new MessageChannel()
    const replies: unknown[] = []
    channel.port1.onmessage = (event) => {
      const data = event.data as Record<string, unknown>
      replies.push(
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
    for (const message of messages) {
      channel.port1.postMessage({ type: SANDBOX_MESSAGE.request, ...message })
    }
    const deadline = Date.now() + waitMs
    while (replies.length < messages.length && Date.now() < deadline) await delay(50)
    channel.port1.close()
    frame.remove()
    return { hello: greeting, replies }
  },

  /**
   * The Lite tier's stream ladder as stage 2.3 will run it: a `/player` call through the
   * sandbox per rung, then the rung's URL in `<audio>`, where a media error or a stall before
   * `playing` counts as a failed probe and moves on to the next rung.
   */
  async resolveAndPlay(options: PlayOptions): Promise<RungResult[]> {
    const results: RungResult[] = []
    const audio = document.createElement('audio')
    audio.muted = true
    audio.preload = 'auto'
    document.body.append(audio)
    try {
      const fetchPlayer = platform().transport.withPriority('current-track')
      for (const rung of options.ladder) {
        const client = {
          ...rung.client,
          ...(options.visitorData === undefined ? {} : { visitorData: options.visitorData }),
        }
        const answer = await outcome(() =>
          fetchPlayer(rung.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              context: { client },
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
    } finally {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio.remove()
    }
  },
}

declare global {
  interface Window {
    fxmHarness: typeof harness
  }
}

window.fxmHarness = harness
