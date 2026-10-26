/**
 * FXM Connect's answer for the first render. The app's platform (`app-platform.ts`) resolves only
 * after its first detection, the Lite self-test included, which can take seconds; this asks FXM
 * Connect once on its own, with a short-lived client from `@fxm/platform`, so the pages and the
 * notices can say what it found right away. Without the marker it answers at once; with it, its
 * ping is one more message within the page.
 *
 * @module
 */

import {
  type ConnectClientOptions,
  type ConnectStatus,
  createConnectClient,
  detectEnvironment,
} from '@fxm/platform'

/** FXM Connect's status, in a browser page; `undefined` elsewhere. */
export async function previewConnect(
  options: ConnectClientOptions = {},
): Promise<ConnectStatus | undefined> {
  if (options.window === undefined) {
    try {
      if (detectEnvironment() !== 'browser') return undefined
    } catch {
      return undefined
    }
  }
  const client = createConnectClient(options)
  try {
    return await client.detect()
  } finally {
    client.dispose()
  }
}
