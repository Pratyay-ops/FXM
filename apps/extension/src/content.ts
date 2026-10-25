// Content script entry (see content-script.ts).
import { ORIGINS, VERSION } from './build-info.ts'
import { startContentScript } from './content-script.ts'
import { webExtApi } from './webext.ts'

const api = webExtApi()

startContentScript({
  window,
  document,
  runtime: api.runtime,
  storage: api.storage.local,
  origins: ORIGINS,
  version: VERSION,
})
