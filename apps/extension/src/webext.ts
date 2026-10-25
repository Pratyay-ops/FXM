/**
 * The few WebExtension APIs FXM Connect uses, typed by hand instead of pulling in a polyfill or
 * the full @types packages. In Manifest V3 both Firefox (`browser.*`) and Chromium (`chrome.*`)
 * return promises from these calls, so picking whichever namespace exists is enough.
 */

/** Who sent a runtime message. Firefox may leave out `origin`, so `url` is the fallback. */
export interface MessageSender {
  id?: string
  url?: string
  origin?: string
  /** `cookieStoreId` is Firefox only: `firefox-default`, `firefox-private` or a container. */
  tab?: { id?: number; incognito?: boolean; cookieStoreId?: string }
  frameId?: number
}

export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

/**
 * A runtime.onMessage listener. Calling `sendResponse` later and returning true is the one
 * asynchronous pattern both browsers support.
 */
export type MessageListener = (
  message: unknown,
  sender: MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean

export interface WebExtApi {
  runtime: {
    id: string
    getManifest(): { version: string }
    sendMessage(message: unknown): Promise<unknown>
    onMessage: { addListener(listener: MessageListener): void }
    openOptionsPage(): Promise<void>
  }
  storage: {
    /**
     * In-memory storage for the browser session (extension pages and background only). The
     * settings are not in storage.local, which content scripts can write: see settings.ts.
     */
    session?: StorageArea
  }
  declarativeNetRequest?: {
    updateEnabledRulesets(options: {
      enableRulesetIds?: string[]
      disableRulesetIds?: string[]
    }): Promise<void>
  }
  action?: { onClicked: { addListener(listener: () => void): void } }
}

/** The extension API of the current context: `browser` (Firefox) or `chrome` (Chromium). */
export function webExtApi(): WebExtApi {
  const scope = globalThis as { browser?: WebExtApi; chrome?: WebExtApi }
  const api = scope.browser?.runtime ? scope.browser : scope.chrome
  if (!api?.runtime) throw new Error('FXM Connect must run as a browser extension')
  return api
}
