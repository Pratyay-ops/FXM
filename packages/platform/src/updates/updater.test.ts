import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeHttp } from '../native.ts'
import { type KeyValueStorage, memoryStorage } from '../storage.ts'
import { createFakeClock } from '../testing/fake-clock.ts'
import { type ActivationInfo, codeArtifact, jsonArtifact, type UpdateArtifact } from './artifact.ts'
import { utf8 } from './encoding.ts'
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
function moduleArtifact(events: Event[], bundledVersion = 1): UpdateArtifact {
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
    },
    { importer: nodeModuleImporter },
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

async function publishModule(
  site: FakeUpdateSite,
  base: string,
  version: number,
  source = `export const version = ${version}; export const answer = 'module ${version}'`,
) {
  const bytes = utf8(source)
  site.publish(
    base,
    MODULE_FILE,
    bytes,
    await signer.sign({ kind: 'test-module', version, api: 1, file: MODULE_FILE, bytes }),
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
      signature: stored?.signature ?? new Uint8Array(),
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
    world.state.setItem(UPDATE_STATE_KEY, JSON.stringify({ 'test-module': { floor: 5, bad: [] } }))
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
    expect(() =>
      createUpdater({
        artifacts: [configArtifact([]), configArtifact([])],
        fetch: world.site.fetch,
      }),
    ).toThrow(/listed twice/)
  })
})

describe('start', () => {
  it('restores, then checks, and reports the problems of both', async () => {
    const world = setup()
    await publishModule(world.site, BASE, 3)
    await updater(world).check()
    const stored = await world.store.get('test-module')
    await world.store.set('test-module', {
      signature: utf8('garbage'),
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
  it('sends a GET with no Origin header through the native HTTP', async () => {
    const calls: Parameters<NativeHttp>[] = []
    const http: NativeHttp = async (url, init) => {
      calls.push([url, init])
      return new Response('ok')
    }
    const signal = new AbortController().signal
    const response = await updateFetchFromNative(http)(`${BASE}${CONFIG_FILE}`, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      signal,
    })
    expect(await response.text()).toBe('ok')
    expect(calls).toEqual([
      [
        `${BASE}${CONFIG_FILE}`,
        { method: 'GET', headers: { origin: '' }, signal, redirect: 'error' },
      ],
    ])
  })
})
