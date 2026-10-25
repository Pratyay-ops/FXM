/**
 * The embed's postMessage API: the page that embeds a player can control it and follow what it
 * plays (protocol 1, documented in this folder's README).
 *
 * - **Who may talk to it:** only the window that embeds the player (`event.source` is
 *   `window.parent`), and only from one origin. The player pairs with that origin on the
 *   page's first `fxm-embed:hello`, or, when the address names an `origin` parameter, only that
 *   origin may pair at all. Every message from another window or origin is ignored, and so is a
 *   parent with an opaque origin, which can't be answered without posting to `'*'`. Opened at
 *   top level, the player has no parent and the API is off.
 * - **Every parameter is checked:** a message's fields are allow-listed per command, and each
 *   value is checked for its type and range. A bad message gets an `fxm-embed:error` reply; a
 *   message that isn't an FXM embed message gets nothing.
 * - **What it says:** only what the player itself shows: the status, the position and the
 *   current track's ID, title and artists. Never the tier, so a site can't use an embed to find
 *   out whether its visitor has FXM Connect.
 * - **Rate limit:** commands that start resolving a track (play an index, next, previous, and
 *   play from a stopped player) are limited to 10 a minute, so a page can't use an embed to
 *   spend its visitor's YouTube request budget.
 *
 * @module
 */

import type { PlayerStatus } from '@fxm/player'
import type { EmbedController, EmbedState } from './controller'

/** The protocol version both sides send. */
export const EMBED_PROTOCOL = 1

/** Every message type of the protocol. */
export const EMBED_MESSAGE = {
  /** Page → player: pair with this page. */
  hello: 'fxm-embed:hello',
  /** Page → player: a command. */
  command: 'fxm-embed:command',
  /** Player → page: what it shows, after a `hello` (or unprompted with an `origin` parameter). */
  ready: 'fxm-embed:ready',
  /** Player → page: its state changed. */
  state: 'fxm-embed:state',
  /** Player → page: a message was refused. */
  error: 'fxm-embed:error',
} as const

/** The types the player sends, which it never answers if a page echoes them back. */
const OUTGOING_TYPES: ReadonlySet<string> = new Set([
  EMBED_MESSAGE.ready,
  EMBED_MESSAGE.state,
  EMBED_MESSAGE.error,
])

/** Every command name. */
export const EMBED_COMMANDS = [
  'play',
  'pause',
  'toggle',
  'next',
  'previous',
  'seek',
  'setVolume',
  'setMuted',
  'getState',
] as const

/** A command's name. */
export type EmbedCommandName = (typeof EMBED_COMMANDS)[number]

/** A command with its checked parameters. */
export type EmbedCommand =
  | { readonly command: 'play'; readonly index?: number }
  | { readonly command: 'pause' | 'toggle' | 'next' | 'previous' | 'getState' }
  | { readonly command: 'seek'; readonly positionMs: number }
  | { readonly command: 'setVolume'; readonly volume: number }
  | { readonly command: 'setMuted'; readonly muted: boolean }

/** A page's own ID for a command, echoed in an error reply. */
export type RequestId = string | number

/**
 * Why the player refused a message:
 *
 * - `bad-request`: a field it doesn't expect, or a value of the wrong type or out of range
 * - `unsupported`: an unknown command, message type or protocol version
 * - `rate-limited`: too many commands that start a track, see {@link RATE_LIMIT}
 * - `not-ready`: the player is still loading, or can't play its content here
 */
export type EmbedErrorCode = 'bad-request' | 'unsupported' | 'rate-limited' | 'not-ready'

/** What reading one message from the page gives. */
export type ReadMessage =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'hello' }
  | { readonly kind: 'command'; readonly command: EmbedCommand; readonly id?: RequestId }
  | {
      readonly kind: 'reject'
      readonly code: EmbedErrorCode
      readonly id?: RequestId
      readonly command?: EmbedCommandName
    }

/** The longest position a `seek` may ask for: 24 hours, in milliseconds. */
export const MAX_SEEK_MS = 24 * 60 * 60 * 1000

/** Commands that start resolving a track: at most `max` within any `windowMs`. */
export const RATE_LIMIT = Object.freeze({ max: 10, windowMs: 60_000 })

/** How often, at most, the position alone triggers a `state` message while playing. */
export const POSITION_INTERVAL_MS = 1000

/** The extra fields each command takes, besides `type`, `protocol`, `id` and `command`. */
const COMMAND_FIELDS: Readonly<Record<EmbedCommandName, readonly string[]>> = {
  play: ['index'],
  pause: [],
  toggle: [],
  next: [],
  previous: [],
  seek: ['positionMs'],
  setVolume: ['volume'],
  setMuted: ['muted'],
  getState: [],
}

const COMMON_FIELDS = ['type', 'protocol', 'id', 'command']

const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,64}$/

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isCommandName(value: unknown): value is EmbedCommandName {
  return typeof value === 'string' && (EMBED_COMMANDS as readonly string[]).includes(value)
}

function isRequestId(value: unknown): value is RequestId {
  if (typeof value === 'string') return REQUEST_ID.test(value)
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * Reads one message from the embedding page, checking every field. Messages that aren't FXM
 * embed messages are ignored (`kind: 'ignore'`), and so are the player's own message types, so
 * a page that echoes messages back can't start a loop of error replies.
 */
export function readMessage(data: unknown): ReadMessage {
  if (!isPlainObject(data)) return { kind: 'ignore' }
  const { type } = data
  if (typeof type !== 'string' || !type.startsWith('fxm-embed:') || OUTGOING_TYPES.has(type)) {
    return { kind: 'ignore' }
  }
  if (type === EMBED_MESSAGE.hello) {
    if (Object.keys(data).some((key) => key !== 'type' && key !== 'protocol')) {
      return { kind: 'reject', code: 'bad-request' }
    }
    return data.protocol === EMBED_PROTOCOL
      ? { kind: 'hello' }
      : { kind: 'reject', code: 'unsupported' }
  }
  if (type !== EMBED_MESSAGE.command) return { kind: 'reject', code: 'unsupported' }

  if (data.id !== undefined && !isRequestId(data.id)) return { kind: 'reject', code: 'bad-request' }
  const id = data.id === undefined ? {} : { id: data.id }
  if (data.protocol !== undefined && data.protocol !== EMBED_PROTOCOL) {
    return { kind: 'reject', code: 'unsupported', ...id }
  }
  const name = data.command
  if (!isCommandName(name)) return { kind: 'reject', code: 'unsupported', ...id }
  const bad: ReadMessage = { kind: 'reject', code: 'bad-request', command: name, ...id }
  const allowed = [...COMMON_FIELDS, ...COMMAND_FIELDS[name]]
  if (Object.keys(data).some((key) => !allowed.includes(key))) return bad

  switch (name) {
    case 'play': {
      if (data.index === undefined) return { kind: 'command', command: { command: name }, ...id }
      const { index } = data
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return bad
      return { kind: 'command', command: { command: name, index }, ...id }
    }
    case 'seek': {
      const { positionMs } = data
      if (!isFiniteNumber(positionMs) || positionMs < 0 || positionMs > MAX_SEEK_MS) return bad
      return { kind: 'command', command: { command: name, positionMs }, ...id }
    }
    case 'setVolume': {
      const { volume } = data
      if (!isFiniteNumber(volume) || volume < 0 || volume > 1) return bad
      return { kind: 'command', command: { command: name, volume }, ...id }
    }
    case 'setMuted': {
      const { muted } = data
      if (typeof muted !== 'boolean') return bad
      return { kind: 'command', command: { command: name, muted }, ...id }
    }
    default:
      return { kind: 'command', command: { command: name }, ...id }
  }
}

/**
 * The player's status as the page sees it: `preparing` while it loads its content,
 * `unavailable` when it can't show it, then the player's own status.
 */
export type EmbedApiStatus = 'preparing' | 'unavailable' | PlayerStatus

/** The state the player reports. Only what it shows anyway; never the tier. */
export interface EmbedApiState {
  readonly status: EmbedApiStatus
  /** Whether playback waits for data. */
  readonly buffering: boolean
  /** The current track's position in the list, or -1. */
  readonly index: number
  /** How many tracks the player can play. */
  readonly trackCount: number
  /** How far into the current track playback is, in milliseconds. */
  readonly positionMs: number
  /** The current track's duration in milliseconds, when known. */
  readonly durationMs: number | null
  /** Volume, from 0 to 1. */
  readonly volume: number
  /** Whether the output is muted. */
  readonly muted: boolean
  /** The current track, as the player shows it. */
  readonly track: {
    readonly id: string
    readonly title: string
    readonly artists: readonly string[]
  } | null
}

/** What the page sees of the embed's state. */
export function toApiState(state: EmbedState): EmbedApiState {
  const player = state.player
  const items = player?.queue.items ?? []
  const index = player?.queue.index ?? -1
  const track = items[index]?.track
  return {
    status:
      state.phase === 'loading'
        ? 'preparing'
        : state.phase === 'unavailable'
          ? 'unavailable'
          : state.started === true
            ? (player?.status ?? 'idle')
            : 'idle',
    buffering: player?.buffering ?? false,
    index: track === undefined ? -1 : index,
    trackCount: items.length,
    positionMs: Math.max(0, Math.round(player?.positionMs ?? 0)),
    durationMs: player?.durationMs === undefined ? null : Math.round(player.durationMs),
    volume: player?.volume ?? 1,
    muted: player?.muted ?? false,
    track:
      track === undefined
        ? null
        : { id: track.id, title: track.title, artists: track.artists.map((artist) => artist.name) },
  }
}

/** Whether two states differ in anything but the position. */
function differsBesidesPosition(a: EmbedApiState, b: EmbedApiState): boolean {
  return (
    a.status !== b.status ||
    a.buffering !== b.buffering ||
    a.index !== b.index ||
    a.trackCount !== b.trackCount ||
    a.durationMs !== b.durationMs ||
    a.volume !== b.volume ||
    a.muted !== b.muted ||
    a.track?.id !== b.track?.id
  )
}

/** The parts of `window` the API uses. */
export interface EmbedApiWindow {
  /** The window that embeds the player; the window itself at top level. */
  readonly parent: Pick<Window, 'postMessage'> | null
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/** What the API needs from the controller. */
export type EmbedApiController = Pick<
  EmbedController,
  | 'target'
  | 'getState'
  | 'subscribe'
  | 'play'
  | 'pause'
  | 'toggle'
  | 'next'
  | 'previous'
  | 'seek'
  | 'setVolume'
  | 'setMuted'
>

/** Options for {@link connectEmbedApi}. */
export interface EmbedApiOptions {
  /** The player's window. */
  readonly window: EmbedApiWindow
  /** The embed's controller. */
  readonly controller: EmbedApiController
  /**
   * The origin the address names (`origin` parameter): only that origin may pair, and the
   * player announces itself to it unprompted once it has loaded.
   */
  readonly controllerOrigin?: string
  /** The clock, in milliseconds, for the rate limit and position updates. Default `Date.now`. */
  readonly now?: () => number
}

/** Player statuses from which `play` or `toggle` starts resolving the track again. */
const STOPPED: ReadonlySet<EmbedApiStatus> = new Set(['idle', 'ended', 'error'])

/**
 * Starts the API on the player's window. Returns a function that stops it. Does nothing at top
 * level, where there is no embedding page.
 */
export function connectEmbedApi(options: EmbedApiOptions): () => void {
  const { window, controller, controllerOrigin } = options
  const now = options.now ?? Date.now
  const parent = window.parent
  if (parent === null || parent === (window as unknown)) return () => {}
  const page = parent

  let paired: string | undefined = controllerOrigin
  let announced = false
  let readyWanted = controllerOrigin !== undefined
  let lastSent: EmbedApiState | undefined
  let lastSentAt = 0
  const starts: number[] = []

  /** Posts to the page, only if its origin is still `origin`. */
  function post(message: Record<string, unknown>, origin = paired): void {
    if (origin === undefined) return
    try {
      page.postMessage({ ...message, protocol: EMBED_PROTOCOL }, origin)
    } catch {
      // The page went away; there is nobody to tell.
    }
  }

  function sendState(state: EmbedApiState): void {
    lastSent = state
    lastSentAt = now()
    post({ type: EMBED_MESSAGE.state, state })
  }

  function sendReady(): void {
    const state = controller.getState()
    if (state.phase === 'loading') {
      readyWanted = true
      return
    }
    readyWanted = false
    announced = true
    const api = toApiState(state)
    lastSent = api
    lastSentAt = now()
    post({
      type: EMBED_MESSAGE.ready,
      embed: {
        kind: controller.target.kind,
        id: controller.target.id,
        title: state.entity?.title ?? null,
        trackCount: api.trackCount,
      },
      state: api,
    })
  }

  function sendError(
    error: { code: EmbedErrorCode; id?: RequestId; command?: EmbedCommandName },
    origin = paired,
  ): void {
    post(
      {
        type: EMBED_MESSAGE.error,
        code: error.code,
        ...(error.id === undefined ? {} : { id: error.id }),
        ...(error.command === undefined ? {} : { command: error.command }),
      },
      origin,
    )
  }

  /** Takes a slot of the rate limit for a command that starts a track, if one is free. */
  function takeStart(): boolean {
    const at = now()
    while (starts.length > 0 && (starts[0] ?? at) <= at - RATE_LIMIT.windowMs) starts.shift()
    if (starts.length >= RATE_LIMIT.max) return false
    starts.push(at)
    return true
  }

  /** Runs a checked command; returns why it was refused, if it was. */
  function run(command: EmbedCommand): EmbedErrorCode | undefined {
    const state = controller.getState()
    const api = toApiState(state)
    switch (command.command) {
      case 'getState':
        sendState(api)
        return undefined
      case 'setVolume':
        controller.setVolume(command.volume)
        return undefined
      case 'setMuted':
        controller.setMuted(command.muted)
        return undefined
      case 'pause':
        controller.pause()
        return undefined
    }
    if (state.phase !== 'ready') return 'not-ready'
    switch (command.command) {
      case 'seek':
        controller.seek(command.positionMs)
        return undefined
      case 'play': {
        const { index } = command
        if (index !== undefined && index >= api.trackCount) return 'bad-request'
        if ((index !== undefined || STOPPED.has(api.status)) && !takeStart()) return 'rate-limited'
        controller.play(index)
        return undefined
      }
      case 'toggle':
        if (STOPPED.has(api.status) && !takeStart()) return 'rate-limited'
        controller.toggle()
        return undefined
      case 'next':
        if (!takeStart()) return 'rate-limited'
        controller.next()
        return undefined
      case 'previous':
        if (!takeStart()) return 'rate-limited'
        controller.previous()
        return undefined
    }
  }

  function onMessage(event: MessageEvent): void {
    // Only the embedding window, from a named origin: the paired one once there is one.
    if (event.source !== page || event.origin === 'null') return
    if (paired !== undefined && event.origin !== paired) return
    const message = readMessage(event.data)
    switch (message.kind) {
      case 'ignore':
        return
      case 'hello':
        paired ??= event.origin
        sendReady()
        return
      case 'reject':
        // Before the pairing too, the parent learns why: a hello of another protocol, say.
        sendError(message, paired ?? event.origin)
        return
      case 'command': {
        // Commands need a pairing first: a hello, or the address's `origin` parameter.
        if (paired === undefined) return
        const refused = run(message.command)
        if (refused !== undefined) {
          sendError({
            code: refused,
            command: message.command.command,
            ...(message.id === undefined ? {} : { id: message.id }),
          })
        }
      }
    }
  }

  function onChange(): void {
    if (paired === undefined) return
    const state = controller.getState()
    if (!announced) {
      if (readyWanted && state.phase !== 'loading') sendReady()
      return
    }
    const api = toApiState(state)
    if (lastSent === undefined || differsBesidesPosition(api, lastSent)) {
      sendState(api)
      return
    }
    const moved = Math.abs(api.positionMs - lastSent.positionMs)
    if (moved === 0) return
    // While playing, the position is reported at most once a second; a jump (a seek, a
    // restart), or a change while paused, at once.
    const jumped = moved >= 2 * POSITION_INTERVAL_MS
    const due = now() - lastSentAt >= POSITION_INTERVAL_MS
    if (jumped || due || api.status !== 'playing') sendState(api)
  }

  window.addEventListener('message', onMessage)
  const unsubscribe = controller.subscribe(onChange)
  // With an `origin` parameter, announce as soon as the content has loaded.
  if (readyWanted) onChange()
  return () => {
    window.removeEventListener('message', onMessage)
    unsubscribe()
  }
}
