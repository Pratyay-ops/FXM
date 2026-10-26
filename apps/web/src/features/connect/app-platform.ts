/**
 * The web app's one platform: `createPlatform` from `@fxm/platform` with the Lite tier's sandbox
 * documents in a browser, and the remote kill switches. Everything that needs a provider context
 * (the sources, the player, the self-test) shares it.
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

/**
 * The app's platform, created on the first call: it resolves once the first detection is done
 * (FXM Connect, then the Lite self-test when FXM Connect gives no full access).
 */
export function getAppPlatform(): Promise<FxmPlatform> {
  pending ??= createPlatform({
    ...(detectEnvironment() === 'browser' ? { sandbox: createSandboxTransport() } : {}),
    killSwitches: appKillSwitches,
  })
  return pending
}
