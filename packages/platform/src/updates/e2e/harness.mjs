/**
 * The e2e harness page: an app whose bundled YouTube module has a deliberately broken parser
 * (the e2e builds it with `brokenFormatParser()`), the updater the desktop and Android apps use,
 * and a fake YouTube with the recorded answers for one song. `window.fxmRun` resolves the song,
 * checks the update URL, resolves it again and reports what happened. This package is marked
 * free of side effects, so importers use the export, not only the global.
 */
import { DEFAULT_QUALITY_PREFS } from '@fxm/core'
import { createYouTubeModuleHost } from '@fxm/sources/youtube/module'
import { desktopContext, fakeYouTube, SONG } from '@fxm/sources/youtube/module/testing'
import { memoryStorage } from '../../storage.ts'
import { codeArtifact } from '../artifact.ts'
import { fromBase64 } from '../encoding.ts'
import { memoryUpdateStore } from '../store.ts'
import { createUpdater } from '../updater.ts'
import { createSignatureVerifier } from '../verify.ts'

// The e2e's throwaway public key, put in at build time: the harness trusts only that key.
const TEST_KEY = __FXM_E2E_TEST_KEY__

async function resolveSong(youtube) {
  try {
    const options = await youtube.audio.resolve(
      SONG,
      desktopContext(fakeYouTube().fetch),
      DEFAULT_QUALITY_PREFS,
    )
    return { ok: true, rung: options[0]?.rung, codec: options[0]?.codec }
  } catch (error) {
    return { ok: false, code: error?.code, message: String(error?.message ?? error) }
  }
}

/** Resolves the song, checks `updatesPath` for a signed module, resolves again, and reports. */
export async function fxmRun(updatesPath, progress = () => {}) {
  progress('starting the app’s YouTube host')
  const youtube = createYouTubeModuleHost()
  progress('resolving with the bundled module')
  const before = await resolveSong(youtube)
  progress('checking for a signed module')
  const updater = createUpdater({
    artifacts: [codeArtifact(youtube.updates.module)],
    fetch: (url, init) => fetch(url, init),
    baseUrls: [new URL(updatesPath, window.location.href).href],
    keys: [{ keyId: TEST_KEY.keyId, publicKey: fromBase64(TEST_KEY.publicKey) }],
    store: memoryUpdateStore(),
    state: memoryStorage(),
  })
  const report = await updater.check()
  progress('resolving again')
  const after = await resolveSong(youtube)
  return {
    before,
    after,
    outcome: report.artifacts[0]?.outcome,
    problems: report.artifacts[0]?.problems.map((problem) => problem.reason) ?? [],
    moduleOrigin: youtube.current().moduleOrigin,
    moduleVersion: youtube.current().module.version,
    engine: await createSignatureVerifier().engine(),
  }
}

// The Playwright test calls it from the page.
window.fxmRun = fxmRun
