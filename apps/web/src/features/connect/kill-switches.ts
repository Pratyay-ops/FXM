/**
 * Where the app's remote kill switches come from. A module of its own, so the shell can read
 * them without loading `@fxm/platform`'s transports, which `app-platform.ts` loads on demand.
 *
 * @module
 */

import type { KillSwitches } from '@fxm/platform'

let killSwitchSource: () => KillSwitches = () => ({})

/**
 * The remote kill switches, read whenever they matter. None until the YouTube config's
 * `killSwitches` field is wired in with {@link setKillSwitchSource}.
 */
export function appKillSwitches(): KillSwitches {
  return killSwitchSource()
}

/**
 * Sets where the kill switches come from, e.g. the YouTube config the app loaded. Call
 * `recheckConnection()` (or the platform's `capabilities.refresh()`) after they change.
 */
export function setKillSwitchSource(source: () => KillSwitches): void {
  killSwitchSource = source
}
