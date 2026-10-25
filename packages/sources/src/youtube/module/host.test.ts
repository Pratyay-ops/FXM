import { isFxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import bundledConfig from '../youtube-config.json'
import type { YouTubeModule, YouTubeModuleOptions } from './api'
import { youtubeModule } from './entry'
import { createYouTubeModuleHost, type YouTubeModuleState } from './host'
import { desktopContext, fakeYouTube } from './testing'
import {
  YOUTUBE_CONFIG_FILE,
  YOUTUBE_CONFIG_KIND,
  YOUTUBE_MODULE_FILE,
  YOUTUBE_MODULE_KIND,
} from './version'

/** A module of `version` that records which version served each search. */
function fakeModule(
  version: number,
  served: number[],
  change: Partial<YouTubeModule> = {},
): YouTubeModule {
  return {
    ...youtubeModule,
    version,
    create(options: YouTubeModuleOptions) {
      const providers = youtubeModule.create(options)
      const search = providers.music.search
      return {
        ...providers,
        music: {
          ...providers.music,
          search: (...args: Parameters<typeof search>) => {
            served.push(version)
            return search(...args)
          },
        },
      }
    },
    ...change,
  }
}

function caught(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

const FETCHED = { origin: 'fetched', version: 2 } as const

describe('createYouTubeModuleHost', () => {
  it('starts on the module and config the app ships with', () => {
    const host = createYouTubeModuleHost()
    expect(host.current()).toEqual({
      module: youtubeModule,
      moduleOrigin: 'bundled',
      config: youtubeModule.config,
      configRevision: bundledConfig.revision,
      configOrigin: 'bundled',
    })
    expect(host.providers()).toBe(host.providers())
  })

  it('describes the two update artifacts', () => {
    const host = createYouTubeModuleHost()
    expect(host.updates.module).toMatchObject({
      kind: YOUTUBE_MODULE_KIND,
      file: YOUTUBE_MODULE_FILE,
      api: 1,
      bundledVersion: youtubeModule.version,
    })
    expect(host.updates.config).toMatchObject({
      kind: YOUTUBE_CONFIG_KIND,
      file: YOUTUBE_CONFIG_FILE,
      bundledVersion: bundledConfig.revision,
    })
  })

  it('hands out live providers: a module update reaches the next call, not a restart', async () => {
    const served: number[] = []
    const host = createYouTubeModuleHost({ bundled: fakeModule(1, served) })
    const youtube = fakeYouTube()
    const ctx = desktopContext(youtube.fetch)
    const { music } = host
    await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    host.updates.module.activate(fakeModule(2, served), FETCHED)
    await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    expect(served).toEqual([1, 2])
    expect(host.current()).toMatchObject({ moduleOrigin: 'fetched', configOrigin: 'module' })
    expect(host.current().module.version).toBe(2)
  })

  it('makes live providers read like the instance in use, and refuses writes', () => {
    const host = createYouTubeModuleHost()
    const { music, video, audio } = host
    expect(music.id).toBe('ytm')
    expect(video.id).toBe('yt')
    expect(audio.id).toBe('ytm')
    expect(music.session).toBe(host.providers().session)
    expect('search' in music).toBe(true)
    expect(Object.keys(audio)).toContain('resolve')
    expect(() => {
      ;(music as { id: string }).id = 'evil'
    }).toThrow(TypeError)
    expect(music.id).toBe('ytm')
  })

  describe('the module update', () => {
    const host = createYouTubeModuleHost()
    const accept = (exports: Record<string, unknown>, version = 2) =>
      caught(() => host.updates.module.accept(exports, { version }))

    it('accepts a module of this contract whose version is the signed one', () => {
      const module = fakeModule(2, [])
      expect(host.updates.module.accept({ youtubeModule: module }, { version: 2 })).toBe(module)
    })

    it.each([
      ['no module', {}],
      ['another contract', { youtubeModule: { ...youtubeModule, version: 2, api: 2 } }],
      ['another version than signed', { youtubeModule: fakeModule(3, []) }],
    ])('refuses %s', (_, exports) => {
      expect(isFxmError(accept(exports), 'Parse')).toBe(true)
    })

    it('refuses a module that can’t read its own config or start', () => {
      const broken = fakeModule(2, [], {
        create: () => {
          throw new Error('boom')
        },
      })
      expect(accept({ youtubeModule: broken })).toEqual(new Error('boom'))
    })

    it('switches back to the bundled module', () => {
      const listener = vi.fn()
      const subject = createYouTubeModuleHost()
      subject.subscribe(listener)
      subject.updates.module.activate(fakeModule(2, []), FETCHED)
      subject.updates.module.useBundled()
      expect(subject.current().module).toBe(youtubeModule)
      expect(subject.current().moduleOrigin).toBe('bundled')
      expect(listener).toHaveBeenCalledTimes(2)
    })
  })

  describe('the config update', () => {
    it('must be the signed revision', () => {
      const host = createYouTubeModuleHost()
      const document = { ...bundledConfig, revision: 5 }
      expect(host.updates.config.accept(document, { version: 5 })).toEqual({
        document,
        revision: 5,
      })
      for (const [json, version] of [
        [document, 6],
        [{ ...bundledConfig, revision: '5' }, 5],
        [null, 5],
        [[5], 5],
      ] as const) {
        const error = caught(() => host.updates.config.accept(json, { version }))
        expect(isFxmError(error, 'Parse')).toBe(true)
      }
    })

    it('waits, unused, for a module that can read it', () => {
      const host = createYouTubeModuleHost()
      // A config for a newer module: the module in use refuses its hosts, say.
      const future = { ...bundledConfig, revision: 6, defaultHost: 'future.example' }
      const value = host.updates.config.accept(future, { version: 6 })
      host.updates.config.activate(value, FETCHED)
      expect(host.current()).toMatchObject({
        configRevision: bundledConfig.revision,
        configOrigin: 'bundled',
      })
      const newer = fakeModule(2, [], {
        checkConfig: (candidate) => (candidate as { revision: number }).revision,
      })
      host.updates.module.activate(newer, FETCHED)
      expect(host.current()).toMatchObject({
        config: future,
        configRevision: 6,
        configOrigin: 'fetched',
      })
    })

    it('replaces the config in use with a newer one, and reverts to it', () => {
      const host = createYouTubeModuleHost()
      const before = host.providers()
      const document = { ...bundledConfig, revision: 5 }
      host.updates.config.activate({ document, revision: 5 }, FETCHED)
      expect(host.current()).toMatchObject({
        config: document,
        configRevision: 5,
        configOrigin: 'fetched',
      })
      expect(host.providers()).not.toBe(before)
      expect(host.providers().session.config.revision).toBe(5)
      host.updates.config.useBundled()
      expect(host.current()).toMatchObject({
        configRevision: bundledConfig.revision,
        configOrigin: 'bundled',
      })
    })

    it('uses the newest config: an update, the module’s own or the app’s', () => {
      const host = createYouTubeModuleHost()
      const own = { ...bundledConfig, revision: 7 }
      host.updates.module.activate(fakeModule(2, [], { config: own }), FETCHED)
      expect(host.current()).toMatchObject({ configRevision: 7, configOrigin: 'module' })
      host.updates.config.activate(
        { document: { ...bundledConfig, revision: 5 }, revision: 5 },
        FETCHED,
      )
      expect(host.current()).toMatchObject({ configRevision: 7, configOrigin: 'module' })
      host.updates.config.activate(
        { document: { ...bundledConfig, revision: 9 }, revision: 9 },
        FETCHED,
      )
      expect(host.current()).toMatchObject({ configRevision: 9, configOrigin: 'fetched' })
    })

    it('drops a config the new module can’t read', () => {
      const host = createYouTubeModuleHost()
      const document = { ...bundledConfig, revision: 5, marker: 'old format' }
      host.updates.config.activate({ document, revision: 5 }, FETCHED)
      const picky = fakeModule(2, [], {
        checkConfig: (candidate) => {
          if ((candidate as { marker?: unknown }).marker !== undefined)
            throw new Error('Unknown field')
          return youtubeModule.checkConfig(candidate)
        },
      })
      host.updates.module.activate(picky, FETCHED)
      expect(host.current()).toMatchObject({
        configRevision: bundledConfig.revision,
        configOrigin: 'module',
      })
    })
  })

  it('tells listeners about changes only, until they unsubscribe', () => {
    const host = createYouTubeModuleHost()
    const states: YouTubeModuleState[] = []
    const unsubscribe = host.subscribe((state) => states.push(state))
    const document = { ...bundledConfig, revision: 5 }
    host.updates.config.activate({ document, revision: 5 }, FETCHED)
    host.updates.config.activate({ document, revision: 5 }, FETCHED)
    expect(states).toHaveLength(1)
    unsubscribe()
    host.updates.config.useBundled()
    expect(states).toHaveLength(1)
  })

  it('keeps going when a listener throws', () => {
    const host = createYouTubeModuleHost()
    const second = vi.fn()
    host.subscribe(() => {
      throw new Error('listener bug')
    })
    host.subscribe(second)
    host.updates.module.activate(fakeModule(2, []), FETCHED)
    expect(second).toHaveBeenCalledOnce()
  })

  it('falls back to the bundled module when a downloaded one fails to start', async () => {
    const host = createYouTubeModuleHost()
    const failing = fakeModule(2, [], {
      create: () => {
        throw new Error('This module is broken')
      },
    })
    host.updates.module.activate(failing, FETCHED)
    const youtube = fakeYouTube()
    const { tracks } = await host.music.search(
      'Radiohead Creep',
      { types: ['track'] },
      desktopContext(youtube.fetch),
    )
    expect(tracks?.items.length).toBeGreaterThan(0)
    expect(host.current().module).toBe(youtubeModule)
  })

  it('fails when the bundled module itself can’t start', () => {
    const broken = fakeModule(1, [], {
      create: () => {
        throw new Error('This build is broken')
      },
    })
    expect(() => createYouTubeModuleHost({ bundled: broken }).providers()).toThrow(
      'This build is broken',
    )
  })

  it('passes its stores and timeout to every module instance', () => {
    const seen: YouTubeModuleOptions[] = []
    const recording = (version: number) =>
      fakeModule(version, [], {
        create: (options) => {
          seen.push(options)
          return youtubeModule.create(options)
        },
      })
    const visitorDataStore = { load: () => undefined, save: () => {}, clear: () => {} }
    const healthStore = { load: () => undefined, save: () => {} }
    const budget = { acquire: async () => {}, reportBotCheck: () => {} }
    const host = createYouTubeModuleHost({
      bundled: recording(1),
      visitorDataStore,
      healthStore,
      budget,
      timeoutMs: 5_000,
    })
    host.providers()
    host.updates.module.activate(recording(2), FETCHED)
    host.providers()
    expect(seen).toEqual([
      { config: youtubeModule.config, visitorDataStore, healthStore, budget, timeoutMs: 5_000 },
      { config: youtubeModule.config, visitorDataStore, healthStore, budget, timeoutMs: 5_000 },
    ])
  })
})
