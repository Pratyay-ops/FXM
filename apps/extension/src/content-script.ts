/**
 * Content script on the FXM pages (run_at document_start). It marks the page with
 * `data-fxm-connect="<version>"` on <html>, answers `fxm-connect:ping` with a pong, and relays
 * the Spotify bridge requests to the background. It accepts messages only from the page
 * itself: `event.source` must be the page's window and `event.origin` an FXM origin.
 */
import { FEATURES, SPOTIFY_LOGIN_FEATURE } from './config.ts'
import {
  type BridgeReply,
  type BridgeRequest,
  errorReply,
  isBridgeReply,
  MESSAGE,
  type MessageEventLike,
  type PageMessage,
  type PageReply,
  readPageMessage,
} from './messages.ts'
import { sharesHost } from './origins.ts'
import { readSpotifyLogin } from './settings.ts'
import type { StorageArea } from './webext.ts'

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
  storage: Pick<StorageArea, 'get'>
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
  const { window, runtime, storage, origins, version } = options
  const origin = window.location.origin
  if (!origins.includes(origin)) return false

  markPresence(options.document, version)

  // Dev build only: the localhost origins share a host, so ask the background to switch to
  // this origin's ruleset (DNR cannot tell ports apart).
  if (sharesHost(origin, origins)) {
    runtime.sendMessage({ type: MESSAGE.activateOrigin }).catch(() => {})
  }

  async function features(): Promise<string[]> {
    const list: string[] = [...FEATURES]
    try {
      if (await readSpotifyLogin(storage)) list.push(SPOTIFY_LOGIN_FEATURE)
    } catch {
      // The extension was reloaded under this page; report the static features.
    }
    return list
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
    void answer(message).then((reply) => window.postMessage(reply, origin))
  })
  return true
}
