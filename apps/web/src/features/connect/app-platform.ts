/**
 * The web app's one platform: `createPlatform` from `@fxm/platform` with the Lite tier's sandbox
 * documents in a browser, the remote kill switches, and the hosts outside the platform's table
 * the app may fetch from (the Spotify secret's, through the sandbox's user-host document in a
 * browser). Everything that needs a provider context (the sources, the player, the self-test)
 * shares it.
 *
 * In the desktop and Android apps `createPlatform` picks their native transport by itself; there
 * is no Lite tier there, so no sandbox. `start.ts` loads this module on demand, so the shell's
 * first render doesn't wait for the transports.
 *
 * @module
 */

import {
  createPlatform,
  createSandboxTransport,
  detectEnvironment,
  type FxmPlatform,
} from '@fxm/platform'
import { appKillSwitches } from './kill-switches'

let pending: Promise<FxmPlatform> | undefined

/** Hosts outside the platform's table that the app may fetch from, read at each request. */
let userHostSource: () => Iterable<string> = () => []

/**
 * Sets where the hosts outside the platform's table come from: the composition root passes the
 * Spotify secret's (`SPOTIFY_SECRET_SOURCE_HOSTS`, known once Spotify's code has loaded). In a
 * browser they go through the sandbox's user-host document (stage 1.10), which the app's CSP
 * doesn't need to list; the desktop and Android apps reach them natively.
 */
export function setAppUserHosts(source: (() => Iterable<string>) | undefined): void {
  userHostSource = source ?? (() => [])
}

/**
 * Whether the app's platform reaches hosts the user added, such as the Spotify secret's: in a
 * browser through the sandbox's user-host document, which `getAppPlatform()` always frames
 * there; in the desktop and Android apps natively.
 */
export const APP_PLATFORM_REACHES_USER_HOSTS = true

/**
 * The app's platform, created on the first call: it resolves once FXM Connect's first detection
 * is done (800 ms at most). Where FXM Connect gives no full access, the Lite self-test then runs
 * on its own, and the capabilities follow its result.
 */
export function getAppPlatform(): Promise<FxmPlatform> {
  pending ??= createPlatform({
    ...(detectEnvironment() === 'browser' ? { sandbox: createSandboxTransport() } : {}),
    killSwitches: appKillSwitches,
    userHosts: () => userHostSource(),
    // The YouTube stream ladder (stage 1.4) reports the bot checks it tells apart from age
    // gates itself, for the app's player and the self-test alike: counting LOGIN_REQUIRED here
    // too would count each twice, and an age gate as a bot check.
    reportLoginRequired: false,
  })
  return pending
}
