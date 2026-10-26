/**
 * The updater with the real YouTube module, end to end in Node: the module bundle exactly as
 * `scripts/sign-module.sh` builds it, signed with a throwaway key, served by a fake site, and
 * loaded through the same `codeArtifact` the desktop and Android apps use. The bundled copy is
 * built with a deliberately broken parser, the case stage 1.13 exists for.
 */
import { DEFAULT_QUALITY_PREFS, isFxmError } from '@fxm/core'
import {
  createYouTubeModuleHost,
  type ActivationInfo as HostActivationInfo,
  type FailureListener as HostFailureListener,
  type UpdateOrigin as HostUpdateOrigin,
  type VersionInUse as HostVersionInUse,
  YOUTUBE_CONFIG_FILE,
  YOUTUBE_CONFIG_KIND,
  YOUTUBE_CONFIG_SCHEMA,
  YOUTUBE_MODULE_FILE,
  YOUTUBE_MODULE_KIND,
  type YouTubeConfigArtifactSpec,
  type YouTubeConfigDocument,
  type YouTubeModule,
  type YouTubeModuleArtifactSpec,
  youtubeModule,
} from '@fxm/sources/youtube/module'
import {
  type BuiltModule,
  brokenFormatParser,
  buildYouTubeModule,
} from '@fxm/sources/youtube/module/build'
import {
  desktopContext,
  fakeYouTube,
  importModuleCode,
  SONG,
} from '@fxm/sources/youtube/module/testing'
import { beforeAll, describe, expect, it } from 'vitest'
import { memoryStorage } from '../storage.ts'
import {
  type ActivationInfo,
  type CodeArtifactSpec,
  codeArtifact,
  type FailureListener,
  type JsonArtifactSpec,
  jsonArtifact,
  type UpdateArtifact,
  type UpdateOrigin,
  type VersionInUse,
} from './artifact.ts'
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
const bundledConfig = youtubeModule.config as { revision: number } & Record<string, unknown>

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
    kind: YOUTUBE_MODULE_KIND,
    version: built.version,
    api: built.api,
    file: YOUTUBE_MODULE_FILE,
    bytes: built.bytes,
  })
  site.publish(BASE, YOUTUBE_MODULE_FILE, bytes, signed)
}

async function publishConfig(site: FakeUpdateSite, document: Record<string, unknown>) {
  const bytes = utf8(JSON.stringify(document))
  const signed = await signer.sign({
    kind: YOUTUBE_CONFIG_KIND,
    version: document.revision as number,
    api: YOUTUBE_CONFIG_SCHEMA,
    file: YOUTUBE_CONFIG_FILE,
    bytes,
  })
  site.publish(BASE, YOUTUBE_CONFIG_FILE, bytes, signed)
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
    store: memoryUpdateStore(),
    state: memoryStorage(),
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

  it('reaches a method the app took from the live provider before the update', async () => {
    const site = fakeUpdateSite()
    const app = await brokenApp()
    const { resolve } = app.youtube.audio
    await publishModule(site, fixedBuild)
    await updaterFor(app.artifacts, site).check()
    const options = await resolve(SONG, desktopContext(fakeYouTube().fetch), DEFAULT_QUALITY_PREFS)
    expect(options[0]).toMatchObject({ rung: 'visionos' })
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
      kind: YOUTUBE_MODULE_KIND,
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
      store: memoryUpdateStore(),
      state: memoryStorage(),
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
  it('is published under the schema it follows', () => {
    expect(YOUTUBE_CONFIG_FILE).toBe(`youtube-config-${YOUTUBE_CONFIG_SCHEMA}.json`)
  })

  it('reaches the providers the app already holds', async () => {
    const site = fakeUpdateSite()
    const app = await brokenApp()
    const clients = bundledConfig.clients as { music: Record<string, unknown> }
    await publishConfig(site, {
      ...bundledConfig,
      revision: 2,
      clients: { ...clients, music: { ...clients.music, version: '1.20261101.01.00' } },
    })
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
      await signer.sign({
        kind: YOUTUBE_CONFIG_KIND,
        version: 2,
        api: YOUTUBE_CONFIG_SCHEMA,
        file: YOUTUBE_CONFIG_FILE,
        bytes,
      }),
    )
    const report = await updaterFor(app.artifacts, site).check()
    expect(report.artifacts[1]?.problems.map((problem) => problem.reason)).toEqual(['load-failed'])
    expect(app.youtube.current().configRevision).toBe(bundledConfig.revision)
  })

  it('that the module in use can’t read is not taken, and raises no floor', async () => {
    const site = fakeUpdateSite()
    const state = memoryStorage()
    const app = await brokenApp()
    await publishConfig(site, { ...bundledConfig, revision: 5, defaultHost: 'future.example' })
    const updater = updaterFor(app.artifacts, site, { state })
    const report = await updater.check()
    expect(report.artifacts[1]).toMatchObject({ outcome: 'failed', version: 1, origin: 'bundled' })
    expect(report.artifacts[1]?.problems.map((problem) => problem.reason)).toEqual(['unusable'])
    expect(updater.status()[1]).toMatchObject({ floor: 0, bad: [] })
    // A fix the module reads, at a lower revision, is still taken.
    await publishConfig(site, { ...bundledConfig, revision: 4 })
    expect((await updater.check()).artifacts[1]).toMatchObject({ outcome: 'updated', version: 4 })
  })

  it('is not downloaded when the module in use brought a newer one', async () => {
    const site = fakeUpdateSite()
    const app = await brokenApp()
    const newer = { ...bundledConfig, revision: 9 }
    app.youtube.updates.module.activate(
      { ...(await importModuleCode(fixedBuild.code)), config: newer },
      { origin: 'fetched', version: 2 },
    )
    await publishConfig(site, { ...bundledConfig, revision: 5 })
    const updater = updaterFor(app.artifacts.slice(1), site)
    expect((await updater.check()).artifacts[0]).toEqual({
      kind: 'youtube-config',
      outcome: 'current',
      version: 9,
      origin: 'fetched',
      problems: [],
    })
    expect(site.requests).toEqual([`${BASE}${YOUTUBE_CONFIG_FILE}.sig`])
    expect(app.youtube.current()).toMatchObject({ configRevision: 9, configOrigin: 'module' })
  })
})

/** Whether two types are the same. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

describe('the host’s types', () => {
  it('mirror the platform’s under the same names, and are artifact specs as they are', () => {
    const mirrors: [
      Same<HostActivationInfo, ActivationInfo>,
      Same<HostUpdateOrigin, UpdateOrigin>,
      Same<HostVersionInUse, VersionInUse>,
      Same<HostFailureListener, FailureListener>,
    ] = [true, true, true, true]
    const specs: [
      YouTubeModuleArtifactSpec extends CodeArtifactSpec<YouTubeModule> ? true : false,
      YouTubeConfigArtifactSpec extends JsonArtifactSpec<YouTubeConfigDocument> ? true : false,
    ] = [true, true]
    expect([...mirrors, ...specs].every(Boolean)).toBe(true)
  })
})
