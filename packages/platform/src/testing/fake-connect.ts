/**
 * A fake FXM Connect for tests: it marks the page and answers pings and bridge requests from the
 * page the way the extension's content script does, through `window.postMessage`.
 *
 * @module
 */

import { CONNECT_MARKER_ATTRIBUTE, CONNECT_MESSAGE, type ConnectWindow } from '../connect'

/** The features a current FXM Connect announces, without the Spotify login. */
export const FAKE_CONNECT_FEATURES = [
  'youtube',
  'googlevideo',
  'spotify',
  'lastfm',
  'spotify-server-time',
] as const

/** A bridge request the fake received. */
export interface FakeBridgeRequest {
  readonly type: string
  readonly id: string | number
  readonly params?: Readonly<Record<string, string>>
}

/** How the fake answers a bridge request: a relayed response, or an error code. */
export type FakeBridgeReply =
  | { readonly status: number; readonly json: unknown }
  | { readonly error: string }

/** Options for {@link installFakeConnect}. */
export interface FakeConnectOptions {
  /** The version it reports. Default `0.1.0`. */
  version?: string
  /** The features its pong lists. Default {@link FAKE_CONNECT_FEATURES}. */
  features?: readonly string[]
  /** Whether it answers pings. Default `true`. */
  answerPings?: boolean
  /** Answers bridge requests. Default: the `login-disabled` error. */
  bridge?: (request: FakeBridgeRequest) => FakeBridgeReply | Promise<FakeBridgeReply>
}

/** Controls of an installed fake. */
export interface FakeConnect {
  /** How many pings it answered or ignored. */
  readonly pings: number
  /** The bridge requests it received, in order. */
  readonly bridgeRequests: readonly FakeBridgeRequest[]
  /** Changes what later pongs say. */
  update(changes: Pick<FakeConnectOptions, 'version' | 'features' | 'answerPings'>): void
  /** Stops answering and removes the marker, like an extension that was removed. */
  uninstall(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Installs a fake FXM Connect on a page: sets the marker and starts answering. */
export function installFakeConnect(
  window: ConnectWindow,
  options: FakeConnectOptions = {},
): FakeConnect {
  let version = options.version ?? '0.1.0'
  let features = [...(options.features ?? FAKE_CONNECT_FEATURES)]
  let answerPings = options.answerPings ?? true
  let pings = 0
  const bridgeRequests: FakeBridgeRequest[] = []
  const origin = window.location.origin

  function onMessage(event: MessageEvent): void {
    if (event.source !== window || event.origin !== origin || !isRecord(event.data)) return
    const data = event.data
    if (data.type === CONNECT_MESSAGE.ping) {
      pings += 1
      if (answerPings) {
        window.postMessage({ type: CONNECT_MESSAGE.pong, version, features: [...features] }, origin)
      }
      return
    }
    if (
      data.type !== CONNECT_MESSAGE.spotifyToken &&
      data.type !== CONNECT_MESSAGE.spotifyServerTime
    ) {
      return
    }
    const id = data.id as string | number
    const request: FakeBridgeRequest = {
      type: data.type,
      id,
      ...(isRecord(data.params) ? { params: data.params as Record<string, string> } : {}),
    }
    bridgeRequests.push(request)
    void Promise.resolve(options.bridge?.(request) ?? { error: 'login-disabled' }).then((reply) => {
      window.postMessage(
        'error' in reply
          ? { type: CONNECT_MESSAGE.error, id, code: reply.error }
          : { type: CONNECT_MESSAGE.response, id, status: reply.status, json: reply.json },
        origin,
      )
    })
  }

  window.addEventListener('message', onMessage)
  window.document.documentElement.setAttribute(CONNECT_MARKER_ATTRIBUTE, version)

  return {
    get pings() {
      return pings
    },
    get bridgeRequests() {
      return bridgeRequests
    },
    update(changes) {
      if (changes.version !== undefined) {
        version = changes.version
        window.document.documentElement.setAttribute(CONNECT_MARKER_ATTRIBUTE, version)
      }
      if (changes.features !== undefined) features = [...changes.features]
      if (changes.answerPings !== undefined) answerPings = changes.answerPings
    },
    uninstall() {
      window.removeEventListener('message', onMessage)
      window.document.documentElement.removeAttribute(CONNECT_MARKER_ATTRIBUTE)
    },
  }
}
