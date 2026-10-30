/**
 * Content script on the FXM pages (run_at document_start). It marks the page with
 * `data-fxm-connect="<version>"` on <html>, answers `fxm-connect:ping` with a pong, and relays
 * the Spotify bridge requests to the background. It accepts messages only from the page
 * itself: `event.source` must be the page's window and `event.origin` an FXM origin.
 *
 * It holds no settings: the Spotify login toggle is only readable by the background, which the
 * content script asks for every pong (see settings.ts for why).
 */
import {
  FEATURES,
  SPOTIFY_LOGIN_FEATURE,
  YOUTUBE_MUSIC_LOGIN_FEATURE,
} from './config.ts'
import {
  type BridgeReply,
  type BridgeRequest,
  errorReply,
  isBridgeReply,
  isLoginStatus,
  isYouTubeMusicLoginStatus,
  MESSAGE,
  type MessageEventLike,
  type PageMessage,
  type PageReply,
  readPageMessage,
} from './messages.ts'
import { sharesHost } from './origins.ts'

/** The parts of `window` the content script uses. */
export interface PageWindow {
  location: { origin: string }
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void
  postMessage(message: unknown, targetOrigin: string): void
}

/** The parts of `document` the content script uses. */
export interface PageDocument {
  documentElement: { dataset: Record<string, string | undefined> } | null
  addEventListener(type: 'DOMContentLoaded', listener: () => void, options: { once: true }): void
}

export interface ContentScriptOptions {
  window: PageWindow
  document: PageDocument
  runtime: { sendMessage(message: unknown): Promise<unknown> }
  origins: readonly string[]
  version: string
}

function markPresence(document: PageDocument, version: string): void {
  const mark = () => {
    if (document.documentElement) document.documentElement.dataset.fxmConnect = version
  }
  // <html> exists at document_start in current browsers; wait for it just in case.
  if (document.documentElement) mark()
  else document.addEventListener('DOMContentLoaded', mark, { once: true })
}

/** Starts the content script. Returns false (and does nothing) outside the FXM origins. */
export function startContentScript(options: ContentScriptOptions): boolean {
  const { window, runtime, origins, version } = options
  const origin = window.location.origin
  if (!origins.includes(origin)) return false

  markPresence(options.document, version)

  // Dev build only: the localhost origins share a host, so ask the background to switch to
  // this origin's ruleset (DNR cannot tell ports apart). The background answers once the switch
  // is done, and every reply waits for that: a page that waits for the pong before its first
  // request never races the switch.
  const ready: Promise<unknown> = sharesHost(origin, origins)
    ? runtime.sendMessage({ type: MESSAGE.activateOrigin }).catch(() => {})
    : Promise.resolve()

  /** The pong's features; the background says whether this tab may use the Spotify login. */
  async function features(): Promise<string[]> {
    const enabled = [...FEATURES]
    try {
      const status = await runtime.sendMessage({ type: MESSAGE.loginStatus })
      if (isLoginStatus(status) && status.enabled) enabled.push(SPOTIFY_LOGIN_FEATURE)
    } catch {
      // The extension was reloaded under this page; report the static features.
    }
    try {
      const status = await runtime.sendMessage({ type: MESSAGE.youtubeMusicLoginStatus })
      if (isYouTubeMusicLoginStatus(status) && status.enabled) {
        enabled.push(YOUTUBE_MUSIC_LOGIN_FEATURE)
      }
    } catch {
      // Static features remain available if the extension background was reloaded.
    }
    return enabled
  }

  async function relay(request: BridgeRequest): Promise<BridgeReply> {
    try {
      const reply = await runtime.sendMessage(request)
      return isBridgeReply(reply, request.id) ? reply : errorReply(request.id, 'unavailable')
    } catch {
      return errorReply(request.id, 'unavailable')
    }
  }

  async function answer(message: PageMessage): Promise<PageReply> {
    switch (message.kind) {
      case 'ping':
        return { type: MESSAGE.pong, version, features: await features() }
      case 'bridge':
        return relay(message.request)
      case 'reject':
        return message.reply
    }
  }

  window.addEventListener('message', (event) => {
    const message = readPageMessage(event, { source: window, origin })
    if (message === null) return
    void ready.then(() => answer(message)).then((reply) => window.postMessage(reply, origin))
  })
  return true
}
