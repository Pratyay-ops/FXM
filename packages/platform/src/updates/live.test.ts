/**
 * Live check of what FXM's site publishes for the desktop and Android apps, only with
 * `FXM_LIVE=1` (`make live-smoke`): the signed YouTube config and module verify against the key
 * compiled into this build, and the module loads. Four requests to the site at most, none to
 * YouTube. It is skipped while `update-keys.json` holds only the placeholder: nothing can be
 * published before the owner creates the key pair.
 */
import { createYouTubeModuleHost } from '@fxm/sources/youtube/module'
import { describe, expect, it } from 'vitest'
import { codeArtifact, jsonArtifact } from './artifact.ts'
import { UPDATE_SIGNING_READY } from './keys.ts'
import { nodeModuleImporter } from './testing.ts'
import { createUpdater, DEFAULT_UPDATE_BASE_URLS } from './updater.ts'

const live =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.FXM_LIVE === '1'

describe.skipIf(!live || !UPDATE_SIGNING_READY)('FXM’s signed updates, live', () => {
  it('serves a config and a module that verify and load', async () => {
    const youtube = createYouTubeModuleHost()
    const updater = createUpdater({
      artifacts: [
        codeArtifact(youtube.updates.module, { importer: nodeModuleImporter }),
        jsonArtifact(youtube.updates.config),
      ],
      fetch: (url, init) => fetch(url, init),
      baseUrls: DEFAULT_UPDATE_BASE_URLS,
    })
    const report = await updater.check()
    for (const artifact of report.artifacts) {
      expect(artifact.problems, `${artifact.kind}: ${JSON.stringify(artifact.problems)}`).toEqual(
        [],
      )
      expect(['updated', 'current']).toContain(artifact.outcome)
    }
  }, 60_000)
})
