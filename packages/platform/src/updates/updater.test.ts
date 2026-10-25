import { FxmError } from '@fxm/core'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeHttp } from '../native.ts'
import { type KeyValueStorage, memoryStorage } from '../storage.ts'
import { createFakeClock } from '../testing/fake-clock.ts'
import {
  type ActivationInfo,
  codeArtifact,
  type FailureListener,
  jsonArtifact,
  type UpdateArtifact,
} from './artifact.ts'
import { keyIdOf } from './digest.ts'
import { utf8 } from './encoding.ts'
import type { ModuleImporter } from './loader.ts'
import { memoryUpdateStore, type UpdateStore } from './store.ts'
import {
  createTestSigner,
  type FakeUpdateSite,
  fakeUpdateSite,
  nodeModuleImporter,
  type TestSigner,
} from './testing.ts'
import {
  createUpdater,
  DEFAULT_UPDATE_BASE_URLS,
  normalizeUpdateBaseUrl,
  UPDATE_STATE_KEY,
  type UpdateProblemReason,
  type UpdateReport,
  type UpdaterOptions,
  updateFetchFromNative,
} from './updater.ts'

const BASE = 'https://fxm.test/updates/'
const MIRROR = 'https://mirror.test/updates/'
const CONFIG_FILE = 'test-config.json'
const MODULE_FILE = 'test-module-1.js'

let signer: TestSigner
let stranger: TestSigner

beforeAll(async () => {
  signer = await createTestSigner()
  stranger = await createTestSigner()
})

/** What an artifact was told, in order. */
type Event =
  | { kind: string; event: 'activate'; value: unknown; info: ActivationInfo }
  | { kind: string; event: 'bundled' }

/** A JSON config whose `revision` must be the signed version. */
function configArtifact(events: Event[], bundledVersion = 1): UpdateArtifact {
  return jsonArtifact({
    kind: 'test-config',
    file: CONFIG_FILE,
    bundledVersion,
    accept(json, statement) {
      if ((json as { revision?: unknown }).revision !== statement.version) {
        throw new Error('The config’s revision is not the signed version')
      }
      return json
    },
    activate: (value, info) => events.push({ kind: 'test-config', event: 'activate', value, info }),
    useBundled: () => events.push({ kind: 'test-config', event: 'bundled' }),
  })
}

/** A module whose exported `version` must be the signed version. */
function moduleArtifact(
  events: Event[],
  bundledVersion = 1,
  extra: { importer?: ModuleImporter; watch?: (failed: FailureListener) => void } = {},
): UpdateArtifact {
  return codeArtifact(
    {
      kind: 'test-module',
      file: MODULE_FILE,
      api: 1,
      bundledVersion,
      accept(exports, statement) {
        if (exports.version !== statement.version) throw new Error('Wrong module version')
        return exports.answer
      },
      activate: (value, info) =>
        events.push({ kind: 'test-module', event: 'activate', value, info }),
      useBundled: () => events.push({ kind: 'test-module', event: 'bundled' }),
      ...(extra.watch === undefined ? {} : { watch: extra.watch }),
    },
    { importer: extra.importer ?? nodeModuleImporter },
  )
}

async function publishConfig(site: FakeUpdateSite, base: string, version: number, by = signer) {
  const bytes = utf8(JSON.stringify({ revision: version, value: `config ${version}` }))
  site.publish(
    base,
    CONFIG_FILE,
    bytes,
    await by.sign({ kind: 'test-config', version, file: CONFIG_FILE, bytes }),
  )
}

function moduleSource(version: number): string {
  return `export const version = ${version}; export const answer = 'module ${version}'`
}

async function publishModule(
  site: FakeUpdateSite,
  base: string,
  version: number,
  source = moduleSource(version),
  by = signer,
) {
  const bytes = utf8(source)
  site.publish(
    base,
    MODULE_FILE,
    bytes,
    await by.sign({ kind: 'test-module', version, api: 1, file: MODULE_FILE, bytes }),
  )
}

interface Setup {
  site: FakeUpdateSite
  events: Event[]
  store: UpdateStore
  state: KeyValueStorage
}

function setup(): Setup {
  return { site: fakeUpdateSite(), events: [], store: memoryUpdateStore(), state: memoryStorage() }
}

function updater(world: Setup, options: Partial<UpdaterOptions> = {}) {
  return createUpdater({
    artifacts: [moduleArtifact(world.events), configArtifact(world.events)],
    fetch: world.site.fetch,
    baseUrls: [BASE],
    store: world.store,
    state: world.state,
    keys: [signer.trusted],
    ...options,
  })
}

function entry(report: UpdateReport, kind: string) {
  const found = report.artifacts.find((artifact) => artifact.kind === kind)
  if (found === undefined) throw new Error(`No report for ${kind}`)
  return found
}

function reasons(report: UpdateReport, kind: string): UpdateProblemReason[] {
  return entry(report, kind).problems.map((problem) => problem.reason)
}

describe('restore', () => {
  it('uses the bundled copies when nothing is stored, without any request', async () => {
    const world = setup()
    const report = await updater(world).restore()
    expect(report.artifacts).toEqual([
      { kind: 'test-module', outcome: 'current', version: 1, origin: 'bundled', problems: [] },
      { kind: 'test-config', outcome: 'current', version: 1, origin: 'bundled', problems: [] },
    ])
    expect(world.events).toEqual([
      { kind: 'test-module', event: 'bundled' },
      { kind: 'test-config', event: 'bundled' },
    ])
    expect(world.site.requests).toEqual([])
  })

  it('switches to the last good versions after a restart, verifying them again', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    await publishConfig(world.site, BASE, 4)
    expect((await updater(world).check()).artifacts.map((artifact) => artifact.outcome)).toEqual([
      'updated',
      'updated',
    ])
    world.events.length = 0
    const restarted = updater(world)
    const report = await restarted.restore()
    expect(report.artifacts.map(({ version, origin }) => ({ version, origin }))).toEqual([
      { version: 3, origin: 'stored' },
      { version: 4, origin: 'stored' },
    ])
    expect(world.events).toEqual([
      {
        kind: 'test-module',
        event: 'activate',
        value: 'module 3',
        info: { origin: 'stored', version: 3 },
      },
      {
        kind: 'test-config',
        event: 'activate',
        value: { revision: 4, value: 'config 4' },
        info: { origin: 'stored', version: 4 },
      },
    ])
  })

  it('drops a stored copy whose bytes changed, and uses the bundled one', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    await updater(world).check()
    const stored = await world.store.get('test-module')
    await world.store.set('test-module', {
      envelope: stored?.envelope ?? new Uint8Array(),
      bytes: utf8("export const version = 3; export const answer = 'evil'"),
    })
    const report = await updater(world).restore()
    expect(entry(report, 'test-module')).toMatchObject({ version: 1, origin: 'bundled' })
    expect(reasons(report, 'test-module')).toEqual(['hash-mismatch'])
    expect(await world.store.get('test-module')).toBeUndefined()
  })

  it('drops a stored copy signed by a key the build no longer trusts', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    await updater(world).check()
    const report = await updater(world, { keys: [stranger.trusted] }).restore()
    expect(entry(report, 'test-module')).toMatchObject({ version: 1, origin: 'bundled' })
    expect(reasons(report, 'test-module')).toEqual(['unknown-key'])
  })

  it('drops a stored copy that the app now ships, or a newer one', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    await updater(world).check()
    const events: Event[] = []
    const report = await createUpdater({
      artifacts: [moduleArtifact(events, 3)],
      fetch: world.site.fetch,
      baseUrls: [BASE],
      store: world.store,
      state: world.state,
      keys: [signer.trusted],
    }).restore()
    expect(report.artifacts[0]).toMatchObject({ version: 3, origin: 'bundled', problems: [] })
    expect(await world.store.get('test-module')).toBeUndefined()
  })

  it('drops a stored version below the highest one this device accepted', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    await updater(world).check()
    world.state.setItem(
      UPDATE_STATE_KEY,
      JSON.stringify({
        'test-module': { floors: { [signer.trusted.keyId]: 5 }, bad: [], badFor: 1 },
      }),
    )
    const report = await updater(world).restore()
    expect(entry(report, 'test-module')).toMatchObject({ version: 1, origin: 'bundled' })
    expect(reasons(report, 'test-module')).toEqual(['rollback'])
  })

  it('falls back to the bundled copy when the stored module fails to load', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    await updater(world).check()
    // A newer app version breaks the stored module's contract: it no longer loads.
    const events: Event[] = []
    const strict = codeArtifact(
      {
        kind: 'test-module',
        file: MODULE_FILE,
        api: 1,
        bundledVersion: 1,
        accept: () => {
          throw new Error('Not a module this app can use')
        },
        activate: () => {},
        useBundled: () => events.push({ kind: 'test-module', event: 'bundled' }),
      },
      { importer: nodeModuleImporter },
    )
    const options = {
      artifacts: [strict],
      fetch: world.site.fetch,
      baseUrls: [BASE],
      store: world.store,
      state: world.state,
      keys: [signer.trusted],
    }
    const report = await createUpdater(options).restore()
    expect(report.artifacts[0]).toMatchObject({ version: 1, origin: 'bundled' })
    expect(report.artifacts[0]?.problems.map((problem) => problem.reason)).toEqual(['load-failed'])
    expect(events).toEqual([{ kind: 'test-module', event: 'bundled' }])
    // That version is never downloaded again.
    world.site.requests.length = 0
    const checked = await createUpdater(options).check()
    expect(checked.artifacts[0]?.problems.map((problem) => problem.reason)).toEqual(['known-bad'])
    expect(world.site.requests).toEqual([`${BASE}${MODULE_FILE}.sig`])
  })

  it('carries on without a store that fails', async () => {
    const world = setup()
    const broken: UpdateStore = {
      get: () => Promise.reject(new Error('IndexedDB is not available')),
      set: () => Promise.reject(new Error('IndexedDB is not available')),
      delete: () => Promise.reject(new Error('IndexedDB is not available')),
    }
    const report = await updater(world, { store: broken }).restore()
    expect(entry(report, 'test-module')).toMatchObject({ version: 1, origin: 'bundled' })
    expect(reasons(report, 'test-module')).toEqual(['store-failed'])
  })
})

describe('check', () => {
  it('fails closed without a trusted key: no request and no change', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    const report = await updater(world, { keys: [] }).check()
    expect(report.artifacts.map((artifact) => artifact.outcome)).toEqual(['skipped', 'skipped'])
    expect(reasons(report, 'test-module')).toEqual(['no-key'])
    expect(world.site.requests).toEqual([])
    expect(world.events).toEqual([])
  })

  it('downloads, verifies and switches to newer versions, then finds them current', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    await publishConfig(world.site, BASE, 4)
    const subject = updater(world)
    const report = await subject.check()
    expect(report.artifacts).toEqual([
      { kind: 'test-module', outcome: 'updated', version: 3, origin: 'fetched', problems: [] },
      { kind: 'test-config', outcome: 'updated', version: 4, origin: 'fetched', problems: [] },
    ])
    expect(world.events).toEqual([
      {
        kind: 'test-module',
        event: 'activate',
        value: 'module 3',
        info: { origin: 'fetched', version: 3 },
      },
      {
        kind: 'test-config',
        event: 'activate',
        value: { revision: 4, value: 'config 4' },
        info: { origin: 'fetched', version: 4 },
      },
    ])
    expect(world.site.requests).toEqual([
      `${BASE}${MODULE_FILE}.sig`,
      `${BASE}${MODULE_FILE}`,
      `${BASE}${CONFIG_FILE}.sig`,
      `${BASE}${CONFIG_FILE}`,
    ])
    expect(subject.status()).toEqual([
      expect.objectContaining({ kind: 'test-module', version: 3, origin: 'fetched', floor: 3 }),
      expect.objectContaining({ kind: 'test-config', version: 4, origin: 'fetched', floor: 4 }),
    ])

    world.site.requests.length = 0
    const again = await subject.check()
    expect(again.artifacts.map((artifact) => artifact.outcome)).toEqual(['current', 'current'])
    // Only the small signature files: nothing newer, so nothing else is downloaded.
    expect(world.site.requests).toEqual([`${BASE}${MODULE_FILE}.sig`, `${BASE}${CONFIG_FILE}.sig`])
  })

  it('keeps the bundled version when the site offers the same or an older one', async () => {
    const world = setup()
    const events: Event[] = []
    await publishModule(world.site, BASE, 3)
    const report = await createUpdater({
      artifacts: [moduleArtifact(events, 5)],
      fetch: world.site.fetch,
      baseUrls: [BASE],
      store: world.store,
      state: world.state,
      keys: [signer.trusted],
    }).check()
    expect(report.artifacts[0]).toEqual({
      kind: 'test-module',
      outcome: 'current',
      version: 5,
      origin: 'bundled',
      problems: [],
    })
    expect(world.site.requests).toEqual([`${BASE}${MODULE_FILE}.sig`])
    expect(events).toEqual([])
  })

  it('refuses a rollback below the highest version it accepted, even after losing its copy', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 5)
    await updater(world).check()
    // The stored copy is lost (cleared site data, an evicted database) and the site is hijacked
    // to serve an older, validly signed version.
    world.store = memoryUpdateStore()
    await publishModule(world.site, BASE, 4)
    const restarted = updater(world)
    await restarted.restore()
    const report = await restarted.check()
    expect(entry(report, 'test-module')).toMatchObject({
      outcome: 'failed',
      version: 1,
      origin: 'bundled',
    })
    expect(reasons(report, 'test-module')).toEqual(['rollback'])
    expect(world.site.requests.filter((url) => url === `${BASE}${MODULE_FILE}`)).toHaveLength(1)
    // Version 5 again, or anything newer, is still welcome.
    await publishModule(world.site, BASE, 5)
    expect(entry(await restarted.check(), 'test-module')).toMatchObject({
      outcome: 'updated',
      version: 5,
    })
  })

  it('tries the next URL when a host is unreachable', async () => {
    const world = setup()
    world.site.unreachable(`${BASE}${MODULE_FILE}.sig`)
    world.site.unreachable(`${BASE}${CONFIG_FILE}.sig`)
    await publishModule(world.site, MIRROR, 3)
    const report = await updater(world, { baseUrls: [BASE, MIRROR] }).check()
    expect(entry(report, 'test-module')).toMatchObject({ outcome: 'updated', version: 3 })
    expect(entry(report, 'test-module').problems).toEqual([
      expect.objectContaining({ reason: 'unreachable', url: `${BASE}${MODULE_FILE}.sig` }),
    ])
    // Nothing is published for the config anywhere: it stays bundled.
    expect(entry(report, 'test-config')).toMatchObject({ outcome: 'failed', version: 1 })
    expect(reasons(report, 'test-config')).toEqual(['unreachable', 'http-error'])
  })

  it('treats a site with nothing published yet as a failed check that changes nothing', async () => {
    const world = setup()
    const report = await updater(world).check()
    expect(report.artifacts.map((artifact) => artifact.outcome)).toEqual(['failed', 'failed'])
    expect(reasons(report, 'test-module')).toEqual(['http-error'])
    expect(world.events).toEqual([])
  })

  it('tries the next URL after a signature by an unknown key or a forged one', async () => {
    const world = setup()
    const bytes = utf8("export const version = 9; export const answer = 'evil'")
    const evil = await stranger.sign({
      kind: 'test-module',
      version: 9,
      api: 1,
      file: MODULE_FILE,
      bytes,
    })
    world.site.publish(BASE, MODULE_FILE, bytes, evil)
    await publishModule(world.site, MIRROR, 3)
    const report = await updater(world, { baseUrls: [BASE, MIRROR] }).check()
    expect(entry(report, 'test-module')).toMatchObject({ outcome: 'updated', version: 3 })
    expect(reasons(report, 'test-module')).toEqual(['unknown-key'])
    expect(world.site.requests).not.toContain(`${BASE}${MODULE_FILE}`)
  })

  it('refuses an artifact whose bytes don’t match its signature', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    world.site.serve(
      `${BASE}${MODULE_FILE}`,
      "export const version = 3; export const answer = 'evil'",
    )
    const report = await updater(world).check()
    expect(entry(report, 'test-module')).toMatchObject({
      outcome: 'failed',
      version: 1,
      origin: 'bundled',
    })
    expect(reasons(report, 'test-module')).toEqual(['hash-mismatch'])
    expect(world.events).toEqual([])
    expect(await world.store.get('test-module')).toBeUndefined()
  })

  it('stops reading an artifact longer than its signed size', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    world.site.serve(`${BASE}${MODULE_FILE}`, 'x'.repeat(100_000))
    const report = await updater(world).check()
    expect(reasons(report, 'test-module')).toEqual(['too-large'])
  })

  it('refuses a body whose Content-Length is over the limit before reading it', async () => {
    const world = setup()
    const body = vi.fn()
    world.site.route(`${BASE}${MODULE_FILE}.sig`, () => {
      body()
      return new Response('{}', { headers: { 'content-length': '999999' } })
    })
    const report = await updater(world).check()
    expect(reasons(report, 'test-module')).toEqual(['too-large'])
    expect(body).toHaveBeenCalledOnce()
  })

  it('refuses a validly signed config served as the module', async () => {
    const world = setup()
    const bytes = utf8('{"revision":3}')
    const config = await signer.sign({ kind: 'test-config', version: 3, file: CONFIG_FILE, bytes })
    world.site.publish(BASE, MODULE_FILE, bytes, config)
    const report = await updater(world).check()
    expect(reasons(report, 'test-module')).toEqual(['wrong-artifact'])
    expect(entry(report, 'test-module').version).toBe(1)
  })

  it('remembers a validly signed version that fails to load, and skips to the next one', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3, 'throw new Error("This module is broken")')
    const subject = updater(world)
    const first = await subject.check()
    expect(entry(first, 'test-module')).toMatchObject({ outcome: 'failed', version: 1 })
    expect(reasons(first, 'test-module')).toEqual(['load-failed'])

    world.site.requests.length = 0
    const second = await subject.check()
    expect(reasons(second, 'test-module')).toEqual(['known-bad'])
    expect(world.site.requests).not.toContain(`${BASE}${MODULE_FILE}`)

    await publishModule(world.site, BASE, 4)
    expect(entry(await subject.check(), 'test-module')).toMatchObject({
      outcome: 'updated',
      version: 4,
    })
  })

  it('switches even when the store refuses to keep the new version', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    const store: UpdateStore = {
      ...memoryUpdateStore(),
      set: () => Promise.reject(new Error('Quota')),
    }
    const report = await updater(world, { store }).check()
    expect(entry(report, 'test-module')).toMatchObject({ outcome: 'updated', version: 3 })
    expect(reasons(report, 'test-module')).toEqual(['store-failed'])
  })

  it('times out a host that never answers', async () => {
    const world = setup()
    const clock = createFakeClock(1_000)
    world.site.hang(`${BASE}${MODULE_FILE}.sig`)
    await publishConfig(world.site, BASE, 2)
    const pending = updater(world, { clock, signatureTimeoutMs: 5_000 }).check()
    await vi.waitFor(() => expect(world.site.requests).toEqual([`${BASE}${MODULE_FILE}.sig`]))
    await clock.advanceAsync(5_000)
    const report = await pending
    expect(reasons(report, 'test-module')).toEqual(['timeout'])
    expect(entry(report, 'test-config')).toMatchObject({ outcome: 'updated', version: 2 })
  })

  it('stops when the caller cancels, keeping what it has', async () => {
    const world = setup()
    world.site.hang(`${BASE}${MODULE_FILE}.sig`)
    const controller = new AbortController()
    const pending = updater(world).check({ signal: controller.signal })
    controller.abort(new DOMException('The app is closing', 'AbortError'))
    await expect(pending).rejects.toThrow('The app is closing')
    expect(world.events).toEqual([])
  })

  it('shares one check between concurrent calls', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    const subject = updater(world)
    const [a, b] = await Promise.all([subject.check(), subject.check()])
    expect(a).toBe(b)
    expect(world.site.requests.filter((url) => url.endsWith('.sig'))).toHaveLength(2)
  })

  it('records when each artifact was last checked', async () => {
    const world = setup()
    const clock = createFakeClock(42_000)
    const subject = updater(world, { clock })
    expect(subject.status()[0]).not.toHaveProperty('lastCheck')
    await subject.check()
    expect(subject.status()[0]).toMatchObject({ lastCheck: { at: 42_000, outcome: 'failed' } })
  })

  it('refuses an artifact listed twice', () => {
    const world = setup()
    expect(() => updater(world, { artifacts: [configArtifact([]), configArtifact([])] })).toThrow(
      /listed twice/,
    )
  })
})

describe('start', () => {
  it('restores, then checks, and reports the problems of both', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    await updater(world).check()
    const stored = await world.store.get('test-module')
    await world.store.set('test-module', {
      envelope: utf8('garbage'),
      bytes: stored?.bytes ?? new Uint8Array(),
    })
    const report = await updater(world).start()
    expect(entry(report, 'test-module')).toMatchObject({
      outcome: 'updated',
      version: 3,
      origin: 'fetched',
    })
    expect(reasons(report, 'test-module')).toEqual(['malformed'])
  })
})

describe('F-Droid builds', () => {
  it('leave code alone until the user opts in, but keep data current', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    await publishConfig(world.site, BASE, 2)
    const report = await updater(world, { distribution: 'fdroid' }).start()
    expect(entry(report, 'test-module')).toMatchObject({
      outcome: 'skipped',
      version: 1,
      origin: 'bundled',
    })
    expect(reasons(report, 'test-module')).toEqual(['needs-opt-in', 'needs-opt-in'])
    expect(entry(report, 'test-config')).toMatchObject({ outcome: 'updated', version: 2 })
    expect(world.site.requests.some((url) => url.includes(MODULE_FILE))).toBe(false)
  })

  it('load code once the user opts in, and drop it again when they opt out', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    let optedIn = true
    const subject = updater(world, { distribution: 'fdroid', allowCode: () => optedIn })
    expect(entry(await subject.check(), 'test-module')).toMatchObject({
      outcome: 'updated',
      version: 3,
    })

    optedIn = false
    const report = await subject.check()
    expect(entry(report, 'test-module')).toMatchObject({
      outcome: 'skipped',
      version: 1,
      origin: 'bundled',
    })
    expect(world.events.at(-1)).toEqual({ kind: 'test-module', event: 'bundled' })

    // After a restart, the stored module stays unloaded while the opt-in is off.
    world.events.length = 0
    const restarted = updater(world, { distribution: 'fdroid', allowCode: () => optedIn })
    expect(entry(await restarted.restore(), 'test-module')).toMatchObject({ origin: 'bundled' })
    expect(world.events.filter((event) => event.event === 'activate')).toEqual([])
    optedIn = true
    expect(entry(await restarted.restore(), 'test-module')).toMatchObject({
      origin: 'stored',
      version: 3,
    })
  })

  it('treat an opt-in setting that throws as off', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    const report = await updater(world, {
      allowCode: () => {
        throw new Error('Settings are not loaded yet')
      },
    }).check()
    expect(entry(report, 'test-module').outcome).toBe('skipped')
  })
})

describe('keys and floors', () => {
  it('refuses keys that are not valid Ed25519 public keys under their own IDs', () => {
    const world = setup()
    const identity = new Uint8Array(32)
    identity[0] = 1
    expect(() =>
      updater(world, { keys: [{ keyId: keyIdOf(identity), publicKey: identity }] }),
    ).toThrow(/not a valid Ed25519 public key/)
    const misnamed = { keyId: 'ed25519-0000000000000000', publicKey: signer.trusted.publicKey }
    expect(() => updater(world, { keys: [misnamed] })).toThrow(/should have the ID/)
  })

  it('needs a store and a state, which rollback protection rests on', () => {
    const world = setup()
    const options = { artifacts: [], fetch: world.site.fetch } as unknown as UpdaterOptions
    expect(() => createUpdater(options)).toThrow(/store and a state/)
  })

  it('forgets the floors of a key the build no longer trusts, so the next key starts afresh', async () => {
    const world = setup()
    // A leaked key signs the highest version there is, and a device takes it.
    const highest = 2 ** 31 - 1
    await publishModule(world.site, BASE, highest, moduleSource(highest), stranger)
    const both = { keys: [signer.trusted, stranger.trusted] }
    expect(entry(await updater(world, both).check(), 'test-module')).toMatchObject({
      outcome: 'updated',
      version: highest,
    })
    // While the build still trusts that key, the owner's next version is a rollback.
    await publishModule(world.site, BASE, 5)
    const stuck = updater(world, both)
    await stuck.restore()
    expect(reasons(await stuck.check(), 'test-module')).toEqual(['rollback'])
    // The app update that drops the leaked key drops its floor too.
    const rotated = updater(world, { keys: [signer.trusted] })
    expect(reasons(await rotated.restore(), 'test-module')).toEqual(['unknown-key'])
    expect(entry(await rotated.check(), 'test-module')).toMatchObject({
      outcome: 'updated',
      version: 5,
    })
    expect(rotated.status()[0]).toMatchObject({ version: 5, floor: 5 })
  })

  it('keeps the highest floor of every trusted key, so a second key can’t roll back the first', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 6)
    const both = { keys: [signer.trusted, stranger.trusted] }
    await updater(world, both).check()
    await publishModule(world.site, BASE, 4, moduleSource(4), stranger)
    expect(reasons(await updater(world, both).check(), 'test-module')).toEqual(['rollback'])
  })

  it('reports a state it can’t save, and holds the floors in memory until the app closes', async () => {
    const world = setup()
    const full: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('The quota has been exceeded', 'QuotaExceededError')
      },
      removeItem: () => {},
    }
    await publishModule(world.site, BASE, 5)
    const subject = updater(world, { state: full })
    const report = await subject.check()
    expect(entry(report, 'test-module')).toMatchObject({ outcome: 'updated', version: 5 })
    expect(reasons(report, 'test-module')).toEqual(['store-failed'])
    // A hijacked site serves an older signed version: still a rollback in this session.
    await publishModule(world.site, BASE, 4)
    expect(reasons(await subject.check(), 'test-module')).toEqual(['rollback'])
    expect(subject.status()[0]).toMatchObject({ floor: 5 })
  })
})

describe('revoked versions', () => {
  it('are refused from the site and dropped from the store', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 4)
    await updater(world).check()
    // The next app update revokes version 4.
    const revoked = { revoked: { 'test-module': [4] } }
    const restored = await updater(world, revoked).restore()
    expect(entry(restored, 'test-module')).toMatchObject({ version: 1, origin: 'bundled' })
    expect(reasons(restored, 'test-module')).toEqual(['revoked'])
    expect(await world.store.get('test-module')).toBeUndefined()
    const checked = await updater(world, revoked).check()
    expect(entry(checked, 'test-module')).toMatchObject({ outcome: 'failed', version: 1 })
    expect(reasons(checked, 'test-module')).toEqual(['revoked'])
    expect(world.site.requests.filter((url) => url === `${BASE}${MODULE_FILE}`)).toHaveLength(1)
  })

  it('send the updater on to the next URL', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 4)
    await publishModule(world.site, MIRROR, 5)
    const report = await updater(world, {
      baseUrls: [BASE, MIRROR],
      revoked: { 'test-module': [4] },
    }).check()
    expect(entry(report, 'test-module')).toMatchObject({ outcome: 'updated', version: 5 })
    expect(reasons(report, 'test-module')).toEqual(['revoked'])
  })
})

describe('versions the app can’t use', () => {
  it('are kept out without being remembered, and tried again on a later check', async () => {
    const world = setup()
    const unreadable = new Set([5])
    const picky = jsonArtifact({
      kind: 'test-config',
      file: CONFIG_FILE,
      bundledVersion: 1,
      accept(json, statement) {
        if (unreadable.has(statement.version)) {
          throw new FxmError('Unsupported', 'The module in use can’t read this config')
        }
        return json
      },
      activate: () => {},
      useBundled: () => {},
    })
    await publishConfig(world.site, BASE, 5)
    const subject = updater(world, { artifacts: [picky] })
    const first = await subject.check()
    expect(first.artifacts[0]).toMatchObject({ outcome: 'failed', version: 1, origin: 'bundled' })
    expect(reasons(first, 'test-config')).toEqual(['unusable'])
    expect(subject.status()[0]).toMatchObject({ floor: 0, bad: [] })
    expect(await world.store.get('test-config')).toBeUndefined()
    // Not a floor: an older config the module reads is still taken.
    await publishConfig(world.site, BASE, 4)
    expect(entry(await subject.check(), 'test-config')).toMatchObject({
      outcome: 'updated',
      version: 4,
    })
    // Not bad: once a module reads it, version 5 is taken.
    unreadable.clear()
    await publishConfig(world.site, BASE, 5)
    expect(entry(await subject.check(), 'test-config')).toMatchObject({
      outcome: 'updated',
      version: 5,
    })
  })

  it('include code on a platform that can’t load any: nothing is downloaded or remembered', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    await updater(world).check()
    const refused: ModuleImporter = () => Promise.reject(new TypeError('Refused by the CSP'))
    const blocked = moduleArtifact([], 1, { importer: refused })
    const subject = updater(world, { artifacts: [blocked] })
    const restored = await subject.restore()
    expect(restored.artifacts[0]).toMatchObject({
      outcome: 'skipped',
      version: 1,
      origin: 'bundled',
    })
    expect(reasons(restored, 'test-module')).toEqual(['code-unsupported'])
    expect(await world.store.get('test-module')).toBeDefined()
    world.site.requests.length = 0
    const checked = await subject.check()
    expect(reasons(checked, 'test-module')).toEqual(['code-unsupported'])
    expect(world.site.requests).toEqual([])
    expect(subject.status()[0]).toMatchObject({ bad: [] })
  })

  it('give a version that failed to load a new chance after an app update', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3, 'throw new Error("Broken with this app version")')
    expect(reasons(await updater(world).check(), 'test-module')).toEqual(['load-failed'])
    expect(reasons(await updater(world).check(), 'test-module')).toEqual(['known-bad'])
    // The next app version ships module 2, and tries version 3 again.
    const next = updater(world, { artifacts: [moduleArtifact([], 2)] })
    expect(next.status()[0]).toMatchObject({ bad: [] })
    expect(reasons(await next.check(), 'test-module')).toEqual(['load-failed'])
  })
})

describe('the version in use', () => {
  it('is what the artifact reports, which offers are compared with', async () => {
    const world = setup()
    const reporting = jsonArtifact({
      kind: 'test-config',
      file: CONFIG_FILE,
      bundledVersion: 1,
      accept: (json) => json,
      activate: () => {},
      useBundled: () => {},
      // Its module brought revision 9 of its own.
      inUse: () => ({ version: 9, origin: 'fetched' }),
    })
    await publishConfig(world.site, BASE, 5)
    const subject = updater(world, { artifacts: [reporting] })
    expect((await subject.check()).artifacts[0]).toEqual({
      kind: 'test-config',
      outcome: 'current',
      version: 9,
      origin: 'fetched',
      problems: [],
    })
    expect(world.site.requests).toEqual([`${BASE}${CONFIG_FILE}.sig`])
    expect(subject.status()[0]).toMatchObject({ version: 9, origin: 'fetched' })
  })

  it('is remembered as bad when it fails at first use, and never restored again', async () => {
    const world = setup()
    let failed: FailureListener = () => {}
    const watched = moduleArtifact(world.events, 1, {
      watch: (listener) => {
        failed = listener
      },
    })
    await publishModule(world.site, BASE, 3)
    const subject = updater(world, { artifacts: [watched] })
    expect(entry(await subject.check(), 'test-module')).toMatchObject({ version: 3 })
    // The artifact went back to its bundled version: the providers of version 3 didn't start.
    failed(3, 'The providers did not start')
    await subject.restore()
    expect(subject.status()[0]).toMatchObject({ version: 1, origin: 'bundled', bad: [3] })
    expect(await world.store.get('test-module')).toBeUndefined()
    const restarted = updater(world, { artifacts: [moduleArtifact([], 1)] })
    expect(entry(await restarted.restore(), 'test-module')).toMatchObject({ origin: 'bundled' })
    expect(reasons(await restarted.check(), 'test-module')).toEqual(['known-bad'])
  })
})

describe('one call at a time', () => {
  it('so a restore never undoes a check under way', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    const memory = memoryUpdateStore()
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const store: UpdateStore = {
      get: (kind) => memory.get(kind),
      delete: (kind) => memory.delete(kind),
      set: async (kind, update) => {
        await gate
        await memory.set(kind, update)
      },
    }
    const subject = updater(world, { store })
    const checking = subject.check()
    const restoring = subject.restore()
    await vi.waitFor(() => expect(world.events).toHaveLength(1))
    open()
    const [checked, restored] = await Promise.all([checking, restoring])
    expect(entry(checked, 'test-module')).toMatchObject({ outcome: 'updated', origin: 'fetched' })
    expect(entry(restored, 'test-module')).toMatchObject({
      outcome: 'current',
      version: 3,
      origin: 'fetched',
    })
    expect(world.events.filter((event) => event.kind === 'test-module')).toHaveLength(1)
  })

  it('so restoring twice changes nothing the second time', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    await updater(world).check()
    world.events.length = 0
    const subject = updater(world)
    await subject.restore()
    const again = await subject.restore()
    expect(entry(again, 'test-module')).toMatchObject({ version: 3, origin: 'stored' })
    expect(world.events.filter((event) => event.kind === 'test-module')).toHaveLength(1)
  })

  it('so a shared check goes on for the callers that still wait', async () => {
    const world = setup()
    const bytes = utf8(moduleSource(3))
    const signed = await signer.sign({
      kind: 'test-module',
      version: 3,
      api: 1,
      file: MODULE_FILE,
      bytes,
    })
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    world.site.serve(`${BASE}${MODULE_FILE}`, bytes)
    world.site.route(`${BASE}${MODULE_FILE}.sig`, async () => {
      await gate
      return new Response(new Uint8Array(signed.envelope))
    })
    const subject = updater(world)
    const leaving = new AbortController()
    const first = subject.check({ signal: leaving.signal })
    const second = subject.check()
    leaving.abort(new DOMException('The settings screen closed', 'AbortError'))
    await expect(first).rejects.toThrow('The settings screen closed')
    open()
    expect(entry(await second, 'test-module')).toMatchObject({ outcome: 'updated', version: 3 })
  })

  it('so a shared check stops once every caller has cancelled', async () => {
    const world = setup()
    let request: AbortSignal | undefined
    world.site.route(`${BASE}${MODULE_FILE}.sig`, (init) => {
      request = init.signal
      return new Promise<Response>(() => {})
    })
    const subject = updater(world)
    const a = new AbortController()
    const b = new AbortController()
    const first = subject.check({ signal: a.signal })
    const second = subject.check({ signal: b.signal })
    await vi.waitFor(() => expect(request).toBeDefined())
    a.abort(new Error('a left'))
    await expect(first).rejects.toThrow('a left')
    expect(request?.aborted).toBe(false)
    b.abort(new Error('b left'))
    await expect(second).rejects.toThrow('b left')
    expect(request?.aborted).toBe(true)
    // A later caller gets a check of its own, not the cancelled one.
    await publishModule(world.site, BASE, 3)
    expect(entry(await subject.check(), 'test-module')).toMatchObject({ outcome: 'updated' })
  })
})

describe('normalizeUpdateBaseUrl', () => {
  it('accepts HTTPS folders, and plain HTTP only on this machine', () => {
    expect(normalizeUpdateBaseUrl('https://fxm.test/updates')).toBe('https://fxm.test/updates/')
    expect(normalizeUpdateBaseUrl('https://fxm.test/updates/')).toBe('https://fxm.test/updates/')
    expect(normalizeUpdateBaseUrl('http://127.0.0.1:6020/updates/')).toBe(
      'http://127.0.0.1:6020/updates/',
    )
    expect(normalizeUpdateBaseUrl('http://localhost:6020/u')).toBe('http://localhost:6020/u/')
    expect(DEFAULT_UPDATE_BASE_URLS.map(normalizeUpdateBaseUrl)).toEqual(DEFAULT_UPDATE_BASE_URLS)
  })

  it.each([
    'http://fxm.test/updates/',
    'https://user:pass@fxm.test/updates/',
    'https://fxm.test/updates/?v=1',
    'https://fxm.test/updates/#top',
    'ftp://fxm.test/updates/',
    'updates/',
  ])('refuses %s', (url) => {
    expect(() => normalizeUpdateBaseUrl(url)).toThrow(/update URL/i)
  })
})

describe('updateFetchFromNative', () => {
  const updateInit = (signal: AbortSignal) =>
    ({ method: 'GET', credentials: 'omit', redirect: 'error', signal }) as const

  it('sends a GET with no headers, Origin or cookies through the native HTTP', async () => {
    const calls: Parameters<NativeHttp>[] = []
    const http: NativeHttp = async (url, init) => {
      calls.push([url, init])
      return new Response('ok')
    }
    const signal = new AbortController().signal
    const response = await updateFetchFromNative(http)(`${BASE}${CONFIG_FILE}`, updateInit(signal))
    expect(await response.text()).toBe('ok')
    expect(calls).toEqual([
      [
        `${BASE}${CONFIG_FILE}`,
        {
          method: 'GET',
          headers: {},
          origin: null,
          route: 'open',
          credentials: 'omit',
          redirect: 'manual',
          signal,
        },
      ],
    ])
  })

  it('refuses a redirect, which native HTTP hands back unfollowed', async () => {
    const http: NativeHttp = async () =>
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } })
    const fetch = updateFetchFromNative(http)
    await expect(
      fetch(`${BASE}${CONFIG_FILE}`, updateInit(new AbortController().signal)),
    ).rejects.toThrow(/redirects \(HTTP 302\)/)
  })

  it('passes other answers on, for the updater to judge', async () => {
    const http: NativeHttp = async () => new Response('missing', { status: 404 })
    const response = await updateFetchFromNative(http)(
      `${BASE}${CONFIG_FILE}`,
      updateInit(new AbortController().signal),
    )
    expect(response.status).toBe(404)
  })

  it('makes the updater count a redirect as unreachable and try the next URL', async () => {
    const world = setup()
    await publishModule(world.site, MIRROR, 3)
    const http: NativeHttp = async (url, init) =>
      url.startsWith(BASE)
        ? new Response(null, { status: 301, headers: { location: `${MIRROR}${MODULE_FILE}` } })
        : world.site.fetch(url, {
            method: 'GET',
            credentials: 'omit',
            redirect: 'error',
            signal: init.signal as AbortSignal,
          })
    const report = await updater(world, {
      artifacts: [moduleArtifact(world.events)],
      baseUrls: [BASE, MIRROR],
      fetch: updateFetchFromNative(http),
    }).check()
    expect(entry(report, 'test-module')).toMatchObject({ outcome: 'updated', version: 3 })
    expect(entry(report, 'test-module').problems).toEqual([
      expect.objectContaining({ reason: 'unreachable', url: `${BASE}${MODULE_FILE}.sig` }),
    ])
  })
})
