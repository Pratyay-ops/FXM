/**
 * Starts the connect feature: called once from `main.tsx`, before the first render.
 *
 * @module
 */

import { startConnectDetection } from './connection'
import { appKillSwitches } from './kill-switches'
import { previewConnect } from './preview'

/**
 * Creates the app's platform and keeps the connection store current. The platform's code loads
 * in a chunk of its own, beside the first render; FXM Connect's answer comes first, from
 * `previewConnect`. In `make dev` and builds made with `VITE_FXM_FAKES=on`, it also loads the
 * development fake mode (`dev-fakes.ts`).
 */
export function startConnect(): void {
  void startConnectDetection(
    () => import('./app-platform').then(({ getAppPlatform }) => getAppPlatform()),
    { killSwitches: appKillSwitches, preview: () => previewConnect() },
  )
  if (import.meta.env.DEV || import.meta.env.VITE_FXM_FAKES === 'on') {
    void import('./dev-fakes').then(({ installConnectFakes }) => installConnectFakes())
  }
}
