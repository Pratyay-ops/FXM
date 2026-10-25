/**
 * Firefox's consent for the Spotify login bridge. Firefox 140 and later (142 on Android) ask the
 * user before an extension hands on data of a category that its manifest declares. The bridge
 * hands the token of the user's Spotify login to the FXM page, so the Firefox manifest declares
 * `authenticationInfo` as optional data collection (manifest.ts). The options page asks for it
 * when the user turns the login on, and the background serves tokens only while Firefox reports
 * it as granted: withdrawing it in Firefox's add-on settings turns the login off.
 *
 * Chromium has no such consent. Its manifest declares nothing, so `needed` is false there and the
 * toggle alone decides.
 */
import type { WebExtApi } from './webext.ts'

/** The data collection category of the login bridge, in Firefox's terms. */
export const LOGIN_DATA_COLLECTION = 'authenticationInfo'

export interface LoginConsent {
  /** This browser asks for consent: the extension's manifest declares the data collection. */
  readonly needed: boolean
  /** Whether the user consented. Always true where no consent is needed. */
  granted(): Promise<boolean>
  /**
   * Asks the user. Call it straight from the handler of a user action, before anything else is
   * awaited, or Firefox refuses. Resolves to whether the user agreed.
   */
  request(): Promise<boolean>
  /** Gives the consent back, when the user turns the login off. */
  release(): Promise<void>
}

/** Whether a manifest declares the login bridge's data collection as optional. */
export function declaresLoginDataCollection(manifest: unknown): boolean {
  const settings = (manifest as { browser_specific_settings?: unknown } | null)
    ?.browser_specific_settings as
    | { gecko?: { data_collection_permissions?: { optional?: unknown } } }
    | undefined
  const optional = settings?.gecko?.data_collection_permissions?.optional
  return Array.isArray(optional) && optional.includes(LOGIN_DATA_COLLECTION)
}

/** The consent of this browser, read from the extension's own manifest. */
export function loginConsent(api: Pick<WebExtApi, 'runtime' | 'permissions'>): LoginConsent {
  const needed = declaresLoginDataCollection(api.runtime.getManifest())
  const request = { data_collection: [LOGIN_DATA_COLLECTION] }
  const permissions = api.permissions
  return {
    needed,
    // Without the permissions API, a browser that should ask can't: the login stays off.
    granted: async () => !needed || ((await permissions?.contains(request)) ?? false),
    request: () => {
      if (!needed) return Promise.resolve(true)
      return permissions ? permissions.request(request) : Promise.resolve(false)
    },
    release: async () => {
      if (needed) await permissions?.remove(request)
    },
  }
}
