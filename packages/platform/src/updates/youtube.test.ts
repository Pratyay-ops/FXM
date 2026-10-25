/**
 * The updater with the real YouTube module, end to end in Node: the module bundle exactly as
 * `scripts/sign-module.sh` builds it, signed with a throwaway key, served by a fake site, and
 * loaded through the same `codeArtifact` the desktop and Android apps use. The bundled copy is
 * built with a deliberately broken parser, the case stage 1.13 exists for.
 */
import { DEFAULT_QUALITY_PREFS, isFxmError } from '@fxm/core'
import {
  createYouTubeModuleHost,
  YOUTUBE_CONFIG_FILE,
  YOUTUBE_MODULE_FILE,
  type YouTubeModule,
} from '@fxm/sources/youtube/module'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  type BuiltModule,
  brokenFormatParser,
  buildYouTubeModule,
} from '../../../sources/src/youtube/module/build.mjs'
import {
  desktopContext,
  fakeYouTube,
  importModuleCode,
  SONG,
} from '../../../sources/src/youtube/module/testing'
import bundledConfig from '../../../sources/src/youtube/youtube-config.json'
import { memoryStorage } from '../storage.ts'
import { codeArtifact, jsonArtifact, type UpdateArtifact } from './artifact.ts'
import { utf8 } from './encoding.ts'
import { memoryUpdateStore } from './store.ts'
import {
  createTestSigner,
  type FakeUpdateSite,
  fakeUpdateSite,
  nodeModuleImporter,
  type TestSigner,
} from './testing.ts'
import { createUpdater, type UpdaterOptions } from './updater.ts'

const BASE = 'https://fxm.test/updates/'

let signer: TestSigner
let brokenBuild: BuiltModule
let fixedBuild: BuiltModule

beforeAll(async () => {
  signer = await createTestSigner()
  // The app ships version 1 with a broken parser; the site gets the fixed version 2.
  brokenBuild = await buildYouTubeModule({ plugins: [brokenFormatParser()] })
  fixedBuild = await buildYouTubeModule({ version: 2 })
}, 120_000)

async function publishModule(site: FakeUpdateSite, built: BuiltModule, bytes = built.bytes) {
  const signed = await signer.sign({
    kind: 'youtube-module',
    version: built.version,
    api: built.api,
    file: YOUTUBE_MODULE_FILE,
    bytes: built.bytes,
  })
  site.publish(BASE, YOUTUBE_MODULE_FILE, bytes, signed)
}

async function brokenApp(bundled?: YouTubeModule) {
  const youtube = createYouTubeModuleHost({
    bundled: bundled ?? (await importModuleCode(brokenBuild.code)),
  })
  const artifacts: UpdateArtifact[] = [
    codeArtifact(youtube.updates.module, { importer: nodeModuleImporter }),
    jsonArtifact(youtube.updates.config),
  ]
  return { youtube, artifacts }
}

function updaterFor(
  artifacts: readonly UpdateArtifact[],
  site: FakeUpdateSite,
  options: Partial<UpdaterOptions> = {},
) {
  return createUpdater({
    artifacts,
    fetch: site.fetch,
    baseUrls: [BASE],
    keys: [signer.trusted],
    ...options,
  })
}

async function resolveSong(youtube: Awaited<ReturnType<typeof brokenApp>>['youtube']) {
  return youtube.audio.resolve(SONG, desktopContext(fakeYouTube().fetch), DEFAULT_QUALITY_PREFS)
}

describe('a signed YouTube module update', () => {
  it('fixes a broken bundled parser without an app update, and survives a restart', async () => {
    const site = fakeUpdateSite()
    const store = memoryUpdateStore()
    const state = memoryStorage()
    const app = await brokenApp()
    const before = await resolveSong(app.youtube).catch((error: unknown) => error)
    expect(isFxmError(before, 'Parse')).toBe(true)

    await publishModule(site, fixedBuild)
    const report = await updaterFor(app.artifacts, site, { store, state }).start()
    expect(report.artifacts[0]).toMatchObject({
      kind: 'youtube-module',
      outcome: 'updated',
      version: 2,
      origin: 'fetched',
    })
    // The same provider object the app already holds now resolves the song.
    const options = await resolveSong(app.youtube)
    expect(options[0]).toMatchObject({ rung: 'visionos', itag: 251, codec: 'opus' })
    expect(app.youtube.current()).toMatchObject({ moduleOrigin: 'fetched' })

    // After a restart, the stored module is verified again and used before any request.
    const restarted = await brokenApp()
    const offline = fakeUpdateSite()
    const restored = await updaterFor(restarted.artifacts, offline, { store, state }).restore()
    expect(restored.artifacts[0]).toMatchObject({ version: 2, origin: 'stored' })
    expect(offline.requests).toEqual([])
    expect((await resolveSong(restarted.youtube))[0]).toMatchObject({ rung: 'visionos' })
  })

  it.each([
    ['changed', 'hash-mismatch', (code: string) => code.replace('youtubeModule', 'youtubeModulE')],
    ['extended', 'too-large', (code: string) => `${code}\nglobalThis.fxmEvil = true`],
  ])(
    'is refused when its bytes were %s, and the app keeps what it ships',
    async (_, reason, change) => {
      const site = fakeUpdateSite()
      const app = await brokenApp()
      const evil = utf8(change(fixedBuild.code))
      await publishModule(site, fixedBuild, evil)
      const report = await updaterFor(app.artifacts, site).check()
      expect(report.artifacts[0]).toMatchObject({
        outcome: 'failed',
        version: 1,
        origin: 'bundled',
      })
      expect(report.artifacts[0]?.problems.map((problem) => problem.reason)).toEqual([reason])
      expect((globalThis as { fxmEvil?: unknown }).fxmEvil).toBeUndefined()
      expect(
        isFxmError(await resolveSong(app.youtube).catch((error: unknown) => error), 'Parse'),
      ).toBe(true)
    },
  )

  it('is refused when signed by another key', async () => {
    const site = fakeUpdateSite()
    const app = await brokenApp()
    const stranger = await createTestSigner()
    const signed = await stranger.sign({
      kind: 'youtube-module',
      version: 2,
      api: 1,
      file: YOUTUBE_MODULE_FILE,
      bytes: fixedBuild.bytes,
    })
    site.publish(BASE, YOUTUBE_MODULE_FILE, fixedBuild.bytes, signed)
    const report = await updaterFor(app.artifacts, site).check()
    expect(report.artifacts[0]?.problems.map((problem) => problem.reason)).toEqual(['unknown-key'])
    expect(app.youtube.current().moduleOrigin).toBe('bundled')
  })

  it('is never fetched by a build that has only the placeholder key', async () => {
    const site = fakeUpdateSite()
    const app = await brokenApp()
    await publishModule(site, fixedBuild)
    const report = await createUpdater({
      artifacts: app.artifacts,
      fetch: site.fetch,
      baseUrls: [BASE],
    }).start()
    expect(report.artifacts.map((artifact) => artifact.outcome)).toEqual(['skipped', 'skipped'])
    expect(site.requests).toEqual([])
    expect(app.youtube.current().moduleOrigin).toBe('bundled')
  })

  it('waits for the user’s opt-in in F-Droid builds', async () => {
    const site = fakeUpdateSite()
    const app = await brokenApp()
    await publishModule(site, fixedBuild)
    let optedIn = false
    const updater = updaterFor(app.artifacts, site, {
      distribution: 'fdroid',
      allowCode: () => optedIn,
    })
    expect((await updater.check()).artifacts[0]?.outcome).toBe('skipped')
    expect(app.youtube.current().moduleOrigin).toBe('bundled')
    optedIn = true
    expect((await updater.check()).artifacts[0]?.outcome).toBe('updated')
    expect((await resolveSong(app.youtube))[0]).toMatchObject({ rung: 'visionos' })
  })
})

describe('a signed YouTube config update', () => {
  it('reaches the providers the app already holds', async () => {
    const site = fakeUpdateSite()
    const app = await brokenApp()
    const config = {
      ...bundledConfig,
      revision: 2,
      clients: {
        ...bundledConfig.clients,
        music: { ...bundledConfig.clients.music, version: '1.20261101.01.00' },
      },
    }
    const bytes = utf8(JSON.stringify(config))
    site.publish(
      BASE,
      YOUTUBE_CONFIG_FILE,
      bytes,
      await signer.sign({ kind: 'youtube-config', version: 2, file: YOUTUBE_CONFIG_FILE, bytes }),
    )
    const report = await updaterFor(app.artifacts, site).check()
    expect(report.artifacts[1]).toMatchObject({
      kind: 'youtube-config',
      outcome: 'updated',
      version: 2,
    })

    const youtube = fakeYouTube()
    await app.youtube.music.search(
      'Radiohead Creep',
      { types: ['track'] },
      desktopContext(youtube.fetch),
    )
    const search = youtube.requests.find((request) => request.url.pathname.endsWith('/search'))
    expect(search?.body).toMatchObject({
      context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20261101.01.00' } },
    })
  })

  it('is refused when its revision is not the signed version', async () => {
    const site = fakeUpdateSite()
    const app = await brokenApp()
    const bytes = utf8(JSON.stringify({ ...bundledConfig, revision: 3 }))
    site.publish(
      BASE,
      YOUTUBE_CONFIG_FILE,
      bytes,
      await signer.sign({ kind: 'youtube-config', version: 2, file: YOUTUBE_CONFIG_FILE, bytes }),
    )
    const report = await updaterFor(app.artifacts, site).check()
    expect(report.artifacts[1]?.problems.map((problem) => problem.reason)).toEqual(['load-failed'])
    expect(app.youtube.current().configRevision).toBe(bundledConfig.revision)
  })
})
