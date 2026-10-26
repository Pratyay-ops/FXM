import { FxmError, isFxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import bundledConfig from '../youtube-config.json'
import type { YouTubeModule, YouTubeModuleOptions } from './api'
import { youtubeModule } from './entry'
import { createYouTubeModuleHost, type YouTubeModuleState } from './host'
import { desktopContext, fakeYouTube } from './testing'
import {
  YOUTUBE_CONFIG_FILE,
  YOUTUBE_CONFIG_KIND,
  YOUTUBE_CONFIG_SCHEMA,
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

  it('describes the two update artifacts, the config under its schema', () => {
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
      api: YOUTUBE_CONFIG_SCHEMA,
      bundledVersion: bundledConfig.revision,
    })
    expect(host.updates.module.inUse()).toEqual({
      version: youtubeModule.version,
      origin: 'bundled',
    })
    expect(host.updates.config.inUse()).toEqual({
      version: bundledConfig.revision,
      origin: 'bundled',
    })
  })

  it('hands out live providers: a module update reaches the next call, not a restart', async () => {
    const served: number[] = []
    const host = createYouTubeModuleHost({ bundled: fakeModule(1, served) })
    const youtube = fakeYouTube()
    const ctx = desktopContext(youtube.fetch)
    const { music } = host
    // A method taken from the live provider follows the module in use too.
    const { search } = host.music
    await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    host.updates.module.activate(fakeModule(2, served), FETCHED)
    await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    await search('Radiohead Creep', { types: ['track'] }, ctx)
    expect(served).toEqual([1, 2, 2])
    expect(host.current()).toMatchObject({ moduleOrigin: 'fetched', configOrigin: 'module' })
    expect(host.current().module.version).toBe(2)
  })

  it('makes live providers read like the instance in use, and refuses writes', () => {
    const host = createYouTubeModuleHost()
    const { music, video, audio } = host
    expect(music.id).toBe('ytm')
    expect(video.id).toBe('yt')
    expect(audio.id).toBe('ytm')
    expect(music.search).toBe(music.search)
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
      [
        'a module that reads its own config as another revision',
        { youtubeModule: fakeModule(2, [], { checkConfig: () => 99 }) },
      ],
      [
        'a module that can’t start',
        {
          youtubeModule: fakeModule(2, [], {
            create: () => {
              throw new Error('boom')
            },
          }),
        },
      ],
      [
        'a module that throws Unsupported, which is still its own fault',
        {
          youtubeModule: fakeModule(2, [], {
            create: () => {
              throw new FxmError('Unsupported', 'Not here')
            },
          }),
        },
      ],
    ])('refuses %s as Parse, so the updater remembers it', (_, exports) => {
      expect(isFxmError(accept(exports), 'Parse')).toBe(true)
    })

    it('switches back to the bundled module', () => {
      const listener = vi.fn()
      const subject = createYouTubeModuleHost()
      subject.subscribe(listener)
      subject.updates.module.activate(fakeModule(2, []), FETCHED)
      expect(subject.updates.module.inUse()).toEqual({ version: 2, origin: 'fetched' })
      subject.updates.module.useBundled()
      expect(subject.current().module).toBe(youtubeModule)
      expect(subject.current().moduleOrigin).toBe('bundled')
      expect(listener).toHaveBeenCalledTimes(2)
    })

    it('switches completely or not at all', () => {
      const subject = createYouTubeModuleHost()
      const before = subject.current()
      const blind = fakeModule(2, [], {
        checkConfig: () => {
          throw new FxmError('Parse', 'Reads no config')
        },
      })
      expect(caught(() => subject.updates.module.activate(blind, FETCHED))).toBeInstanceOf(Error)
      expect(subject.current()).toBe(before)
      expect(subject.updates.module.inUse()).toEqual({ version: 1, origin: 'bundled' })
      // The next good update is not affected by the refused one.
      const document = { ...bundledConfig, revision: 5 }
      subject.updates.config.activate({ document, revision: 5 }, FETCHED)
      expect(subject.current()).toMatchObject({ module: youtubeModule, configRevision: 5 })
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

    it('that the module in use can’t read is refused as Unsupported, which isn’t remembered', () => {
      const host = createYouTubeModuleHost()
      const future = { ...bundledConfig, revision: 6, defaultHost: 'future.example' }
      const error = caught(() => host.updates.config.accept(future, { version: 6 }))
      expect(isFxmError(error, 'Unsupported')).toBe(true)
      // A module that reads it takes it.
      host.updates.module.activate(
        fakeModule(2, [], {
          checkConfig: (candidate) => (candidate as { revision: number }).revision,
          create: () => youtubeModule.create({ config: youtubeModule.config }),
        }),
        FETCHED,
      )
      expect(host.updates.config.accept(future, { version: 6 })).toEqual({
        document: future,
        revision: 6,
      })
    })

    it('that doesn’t start the module in use is refused as Parse', () => {
      const host = createYouTubeModuleHost()
      host.updates.module.activate(
        fakeModule(2, [], {
          create: (options) => {
            if ((options.config as { revision: number }).revision === 7) throw new Error('boom')
            return youtubeModule.create(options)
          },
        }),
        FETCHED,
      )
      const document = { ...bundledConfig, revision: 7 }
      expect(
        isFxmError(
          caught(() => host.updates.config.accept(document, { version: 7 })),
          'Parse',
        ),
      ).toBe(true)
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
      expect(host.updates.config.inUse()).toEqual({ version: 5, origin: 'fetched' })
      expect(host.providers()).not.toBe(before)
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
      // The module brought it, so it counts as fetched for the updater.
      expect(host.updates.config.inUse()).toEqual({ version: 7, origin: 'fetched' })
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

  it('goes back to the bundled module when a downloaded one fails to start, and says so', async () => {
    const host = createYouTubeModuleHost()
    const failures: [number, string][] = []
    host.updates.module.watch((version, reason) => failures.push([version, reason]))
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
    expect(host.updates.module.inUse()).toEqual({ version: 1, origin: 'bundled' })
    expect(failures).toEqual([[2, 'This module is broken']])
  })

  it('drops a config update that doesn’t start the module, and says so', () => {
    const host = createYouTubeModuleHost({
      bundled: fakeModule(1, [], {
        create: (options) => {
          if ((options.config as { revision: number }).revision === 5) throw new Error('boom')
          return youtubeModule.create(options)
        },
      }),
    })
    const failures: number[] = []
    host.updates.config.watch((revision) => failures.push(revision))
    host.updates.config.activate(
      { document: { ...bundledConfig, revision: 5 }, revision: 5 },
      FETCHED,
    )
    expect(host.providers().music.id).toBe('ytm')
    expect(host.current()).toMatchObject({ configRevision: bundledConfig.revision })
    expect(failures).toEqual([5])
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
