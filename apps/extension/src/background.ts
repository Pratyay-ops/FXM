// Background entry: a service worker in Chromium, an event page in Firefox (see bridge.ts).
// Listeners are registered synchronously so the browser can wake the background for them.

import { createBridge } from './bridge.ts'
import { ORIGINS } from './build-info.ts'
import { indexedDbSettings } from './settings.ts'
import { webExtApi } from './webext.ts'

const api = webExtApi()

const bridge = createBridge({
  runtimeId: api.runtime.id,
  origins: ORIGINS,
  settings: indexedDbSettings(indexedDB),
  session: api.storage.session,
  dnr: api.declarativeNetRequest,
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
})

api.runtime.onMessage.addListener(bridge.listener)

// The toolbar button opens the options page, where the Spotify login toggle lives.
api.action?.onClicked.addListener(() => {
  api.runtime.openOptionsPage().catch(() => {})
})
