import { DEFAULT_QUALITY_PREFS, isFxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import bundledConfig from '../youtube-config.json'
import { isYouTubeModule } from './api'
import { youtubeModule } from './entry'
import { desktopContext, fakeYouTube, SONG } from './testing'
import { YOUTUBE_MODULE_API, YOUTUBE_MODULE_FILE, YOUTUBE_MODULE_VERSION } from './version'

describe('youtubeModule', () => {
  it('is this build’s module: its contract, version and config', () => {
    expect(isYouTubeModule(youtubeModule)).toBe(true)
    expect(youtubeModule.api).toBe(YOUTUBE_MODULE_API)
    expect(youtubeModule.version).toBe(YOUTUBE_MODULE_VERSION)
    expect(youtubeModule.config).toEqual(bundledConfig)
    expect(YOUTUBE_MODULE_FILE).toBe(`youtube-module-${YOUTUBE_MODULE_API}.js`)
  })

  it('cannot be changed by the app', () => {
    expect(Object.isFrozen(youtubeModule)).toBe(true)
    expect(Object.isFrozen((youtubeModule.config as { clients: object }).clients)).toBe(true)
  })

  it('checks both parts of a config document and returns its revision', () => {
    expect(youtubeModule.checkConfig(bundledConfig)).toBe(bundledConfig.revision)
    expect(youtubeModule.checkConfig({ ...bundledConfig, revision: 7 })).toBe(7)
  })

  it.each([
    [
      'a metadata client on another host',
      {
        clients: {
          ...bundledConfig.clients,
          music: { ...bundledConfig.clients.music, host: 'evil.example' },
        },
      },
    ],
    [
      'a stream client on another host',
      {
        streams: {
          rungs: [
            {
              ...bundledConfig.streams.rungs[0],
              client: { name: 'VISIONOS', version: '1.02', host: 'evil.example' },
            },
          ],
        },
      },
    ],
    ['no stream ladder', { streams: undefined }],
    ['another schema', { schema: 2 }],
  ])('refuses a config with %s', (_, change) => {
    const error = (() => {
      try {
        youtubeModule.checkConfig({ ...bundledConfig, ...change })
        return undefined
      } catch (caught) {
        return caught
      }
    })()
    expect(isFxmError(error, 'Parse')).toBe(true)
  })

  it('creates the providers on one session, without a request', () => {
    const youtube = fakeYouTube()
    const providers = youtubeModule.create({ config: youtubeModule.config })
    expect(providers.music.id).toBe('ytm')
    expect(providers.video.id).toBe('yt')
    expect(providers.audio.id).toBe('ytm')
    // Only the contract's providers cross; the session they share stays inside the module.
    expect(Object.keys(providers).sort()).toEqual(['audio', 'music', 'video'])
    const sessionOf = (provider: object) => (provider as { session?: unknown }).session
    expect(sessionOf(providers.video)).toBe(sessionOf(providers.music))
    expect(sessionOf(providers.audio)).toBe(sessionOf(providers.music))
    expect(youtube.requests).toEqual([])
  })

  it('searches and resolves a song with the config it is given', async () => {
    const youtube = fakeYouTube()
    const ctx = desktopContext(youtube.fetch)
    const { music, audio } = youtubeModule.create({ config: { ...bundledConfig, revision: 9 } })
    const { tracks } = await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    expect(tracks?.items[0]).toMatchObject({ title: 'Creep', kind: 'song' })
    const options = await audio.resolve(SONG, ctx, DEFAULT_QUALITY_PREFS)
    expect(options[0]).toMatchObject({ rung: 'visionos', codec: 'opus', fullLength: 'unverified' })
  })

  it('keeps the visitorData and the ladder’s health in the stores it is given', async () => {
    const youtube = fakeYouTube()
    const visitorDataStore = { load: vi.fn(async () => undefined), save: vi.fn(), clear: vi.fn() }
    const healthStore = { load: vi.fn(async () => undefined), save: vi.fn() }
    const { audio } = youtubeModule.create({ config: bundledConfig, visitorDataStore, healthStore })
    await audio.resolve(SONG, desktopContext(youtube.fetch), DEFAULT_QUALITY_PREFS)
    expect(visitorDataStore.load).toHaveBeenCalled()
    expect(visitorDataStore.save).toHaveBeenCalled()
    expect(healthStore.load).toHaveBeenCalled()
    expect(healthStore.save).toHaveBeenCalled()
  })

  it('refuses a config it can’t use when creating providers', () => {
    expect(() => youtubeModule.create({ config: { schema: 1 } })).toThrow(/Invalid YouTube config/)
  })
})

describe('isYouTubeModule', () => {
  it.each([
    ['null', null],
    ['another contract', { ...youtubeModule, api: 2 }],
    ['a version of 0', { ...youtubeModule, version: 0 }],
    ['a fractional version', { ...youtubeModule, version: 1.5 }],
    ['no config', { ...youtubeModule, config: undefined }],
    ['no create', { ...youtubeModule, create: 'create' }],
    ['no checkConfig', { ...youtubeModule, checkConfig: undefined }],
  ])('refuses %s', (_, value) => {
    expect(isYouTubeModule(value)).toBe(false)
  })
})
