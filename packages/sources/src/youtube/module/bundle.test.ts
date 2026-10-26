import { DEFAULT_QUALITY_PREFS, FxmError, isFxmError } from '@fxm/core'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import bundledConfig from '../youtube-config.json'
import { isYouTubeModule, type YouTubeModule } from './api'
import { type BuiltModule, brokenFormatParser, buildYouTubeModule } from './build.mjs'
import { desktopContext, fakeYouTube, importModuleCode, SONG } from './testing'
import { YOUTUBE_MODULE_API, YOUTUBE_MODULE_FILE, YOUTUBE_MODULE_VERSION } from './version'

// The real bundle, as `scripts/sign-module.sh` builds it, imported from its bytes alone.
let built: BuiltModule
let module: YouTubeModule
let broken: YouTubeModule

beforeAll(async () => {
  built = await buildYouTubeModule()
  module = await importModuleCode(built.code)
  broken = await importModuleCode(
    (await buildYouTubeModule({ plugins: [brokenFormatParser()] })).code,
  )
}, 120_000)

describe('the built module', { timeout: 30_000 }, () => {
  it('is one self-contained ES module that exports youtubeModule', () => {
    expect(built).toMatchObject({
      fileName: YOUTUBE_MODULE_FILE,
      api: YOUTUBE_MODULE_API,
      version: YOUTUBE_MODULE_VERSION,
    })
    // Compared as text: a deep comparison of 700 KB of bytes takes seconds on a busy machine.
    expect(new TextDecoder().decode(built.bytes) === built.code).toBe(true)
    expect(built.code).not.toMatch(/^\s*import[\s{*]/mu)
    expect(built.code).toMatch(/export\s*\{[^}]*\byoutubeModule\b/u)
    // Minified: far smaller than the sources it holds, youtubei.js included.
    expect(built.bytes.length).toBeLessThan(2 * 1024 * 1024)
  })

  it('opens with the licence notices of everything bundled into it, inside the signed bytes', () => {
    const banner = built.code.slice(0, built.code.indexOf('*/') + 2)
    expect(banner.startsWith('/*!\n * FXM YouTube resolver module, version 1')).toBe(true)
    for (const notice of [
      '== @bufbuild/protobuf ',
      'Copyright 2021-2026 Buf Technologies, Inc.',
      // The varint code @bufbuild/protobuf took from Google's protobuf, under BSD-3-Clause.
      'Copyright 2008 Google Inc.',
      '== fflate ',
      '== meriyah ',
      'ISC License',
      '== youtubei.js ',
      'Copyright (c) 2021 LuanRT',
      'Permission is hereby granted, free of charge',
      '== Apache License 2.0 ==',
      'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
    ]) {
      expect(banner).toContain(notice)
    }
  })

  it('reaches the network only through ctx.fetch: every other way out throws', async () => {
    const used: string[] = []
    const blocked = (name: string) => {
      const fail = () => {
        used.push(name)
        throw new Error(`The module used ${name} instead of ctx.fetch`)
      }
      return new Proxy(() => {}, { apply: fail, construct: fail })
    }
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) {
      vi.stubGlobal(name, blocked(name))
    }
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: blocked('sendBeacon'),
    })
    try {
      // A fresh copy, imported with the doors closed, in case it keeps a reference from then.
      const isolated = await importModuleCode(`${built.code}\n// isolated copy\n`)
      const youtube = fakeYouTube()
      const ctx = desktopContext(youtube.fetch)
      const { music, audio } = isolated.create({ config: isolated.config })
      const { tracks } = await music.search('Radiohead Creep', { types: ['track'] }, ctx)
      expect(tracks?.items[0]).toMatchObject({ title: 'Creep' })
      expect((await audio.resolve(SONG, ctx, DEFAULT_QUALITY_PREFS))[0]).toMatchObject({
        rung: 'visionos',
      })
      expect(youtube.requests.length).toBeGreaterThan(0)
    } finally {
      vi.unstubAllGlobals()
      Reflect.deleteProperty(navigator, 'sendBeacon')
    }
    expect(used).toEqual([])
  })

  it('works from its bytes alone, like the copy the app ships with', async () => {
    expect(isYouTubeModule(module)).toBe(true)
    expect(module.version).toBe(YOUTUBE_MODULE_VERSION)
    expect(module.checkConfig(module.config)).toBe(bundledConfig.revision)
    const youtube = fakeYouTube()
    const ctx = desktopContext(youtube.fetch)
    const { music, audio } = module.create({ config: module.config })
    const { tracks } = await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    expect(tracks?.items[0]).toMatchObject({ title: 'Creep', kind: 'song' })
    const options = await audio.resolve(SONG, ctx, DEFAULT_QUALITY_PREFS)
    expect(options[0]).toMatchObject({ rung: 'visionos', itag: 251, codec: 'opus' })
  })

  it('throws errors the app recognizes, though they come from its own copy of the core', async () => {
    const error = await module
      .create({ config: module.config })
      .audio.resolve(
        { ...SONG, ref: 'not a video' },
        desktopContext(fakeYouTube().fetch),
        DEFAULT_QUALITY_PREFS,
      )
      .catch((caught: unknown) => caught)
    expect(isFxmError(error, 'NotFound')).toBe(true)
    expect(error).not.toBeInstanceOf(FxmError)
  })

  it('takes another version when a test asks for one', async () => {
    const other = await buildYouTubeModule({ version: 5 })
    expect(other.version).toBe(5)
    expect((await importModuleCode(other.code)).version).toBe(5)
  }, 120_000)

  it('builds to the same bytes from the same sources, so a published module can be checked', async () => {
    const again = await buildYouTubeModule()
    // Compared as text, for speed (see above).
    expect(again.code === built.code).toBe(true)
  }, 120_000)
})

describe('a module built with a deliberately broken parser', { timeout: 30_000 }, () => {
  it('finds no audio in a /player answer, as a YouTube change could make it', async () => {
    const youtube = fakeYouTube()
    const error = await broken
      .create({ config: broken.config })
      .audio.resolve(SONG, desktopContext(youtube.fetch), DEFAULT_QUALITY_PREFS)
      .catch((caught: unknown) => caught)
    expect(isFxmError(error, 'Parse')).toBe(true)
    expect((error as Error).message).toMatch(/has no direct audio/)
  })

  it('still reads search results: only that one parser is broken', async () => {
    const youtube = fakeYouTube()
    const { tracks } = await broken
      .create({ config: broken.config })
      .music.search('Radiohead Creep', { types: ['track'] }, desktopContext(youtube.fetch))
    expect(tracks?.items[0]).toMatchObject({ title: 'Creep' })
  })
})
