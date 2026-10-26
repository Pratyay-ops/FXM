import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_YOUTUBE_CONFIG,
  INNERTUBE_HOSTS,
  labelsFor,
  parseYouTubeConfig,
  pickYouTubeConfig,
  type YouTubeConfig,
} from './config'
import bundled from './youtube-config.json'

type Json = { [key: string]: unknown }

/** A deep copy of the bundled config with the value at `path` set, or removed for `undefined`. */
function variant(...changes: [path: string, value: unknown][]): unknown {
  const copy = structuredClone(bundled) as Json
  for (const [path, value] of changes) {
    const keys = path.split('.')
    const last = keys.pop() as string
    let target = copy
    for (const key of keys) target = target[key] as Json
    if (value === undefined) delete target[last]
    else target[last] = value
  }
  return copy
}

function parseError(input: unknown): string {
  try {
    parseYouTubeConfig(input)
  } catch (error) {
    expect(isFxmError(error, 'Parse')).toBe(true)
    return (error as Error).message
  }
  throw new Error('the config was accepted')
}

describe('the YouTube config', () => {
  it('ships a valid, frozen config whose hosts are all InnerTube hosts', () => {
    const config = BUNDLED_YOUTUBE_CONFIG
    expect(config.schema).toBe(1)
    expect(config.revision).toBeGreaterThanOrEqual(1)
    expect(config.clients.music).toMatchObject({ name: 'WEB_REMIX', host: 'music.youtube.com' })
    expect(config.clients.web).toMatchObject({ name: 'WEB', host: 'www.youtube.com' })
    for (const client of Object.values(config.clients)) {
      expect(INNERTUBE_HOSTS).toContain(client.host)
      expect(client.version).toMatch(/^\d+\.\d{8}\.\d{2}\.\d{2}$/)
    }
    expect(new URL(config.visitorData.swJsDataUrl).hostname).toBe('www.youtube.com')
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.clients.music)).toBe(true)
    expect(Object.isFrozen(config.labels.en?.itemTypes)).toBe(true)
    expect(config.killSwitches).toEqual({ lite: false })
    expect(() => {
      ;(config.clients.music as { host: string }).host = 'evil.example'
    }).toThrow(TypeError)
  })

  it('refuses any host outside the InnerTube allowlist, wherever it appears', () => {
    expect(parseError(variant(['clients.music.host', 'evil.example']))).toContain(
      'clients.music.host',
    )
    expect(parseError(variant(['defaultHost', 'youtube.com.evil.example']))).toContain(
      'defaultHost',
    )
    expect(
      parseError(variant(['visitorData.swJsDataUrl', 'https://evil.example/sw.js_data'])),
    ).toContain('visitorData.swJsDataUrl (host)')
    for (const url of [
      'http://www.youtube.com/sw.js_data',
      'https://user:pass@www.youtube.com/sw.js_data',
      'https://www.youtube.com:8443/sw.js_data',
      'not a url',
    ]) {
      expect(parseError(variant(['visitorData.swJsDataUrl', url]))).toContain(
        'visitorData.swJsDataUrl',
      )
    }
  })

  it('checks the schema, the revision and every field', () => {
    expect(parseError(variant(['schema', 2]))).toContain('schema')
    expect(parseError(variant(['revision', 0]))).toContain('revision')
    expect(parseError(variant(['revision', 1.5]))).toContain('revision')
    expect(parseError(variant(['updated', 'yesterday']))).toContain('updated')
    expect(parseError(variant(['clients.web.name', 'web; DROP']))).toContain('clients.web.name')
    expect(parseError(variant(['clients.web.version', 'latest']))).toContain('clients.web.version')
    expect(parseError(variant(['search.music.songs', undefined]))).toContain('search.music.songs')
    expect(parseError(variant(['search.web.videos', 'a b']))).toContain('search.web.videos')
    expect(parseError(variant(['radio.params', '']))).toContain('radio.params')
    expect(parseError(variant(['labels.en.albumTypes.single', 'mixtape']))).toContain(
      'labels.en.albumTypes.single',
    )
    expect(parseError(variant(['labels.en.itemTypes', ['song', 3]]))).toContain(
      'labels.en.itemTypes[1]',
    )
    expect(parseError(variant(['labels.en', undefined]))).toContain('labels.en is required')
    expect(
      parseError(variant(['labels.English', { albumTypes: {}, itemTypes: [], trackCounts: [] }])),
    ).toContain('labels.English needs a language tag')
    expect(parseError(variant(['killSwitches.lite', 'yes']))).toContain('killSwitches.lite')
    expect(parseError(variant(['killSwitches', []]))).toContain('killSwitches must be an object')
    expect(parseError(null)).toContain('config must be an object')
    expect(parseError([])).toContain('config must be an object')
  })

  it('ignores fields it does not know, so a newer config of the same schema loads', () => {
    const config = parseYouTubeConfig(
      variant(['experiments', { sabr: true }], ['clients.music.userAgent', 'whatever']),
    )
    expect(config).not.toHaveProperty('experiments')
    expect(config.clients.music).not.toHaveProperty('userAgent')
  })

  it('normalizes labels to lower case', () => {
    const config = parseYouTubeConfig(
      variant(
        ['labels.en.albumTypes', { Single: 'single', ' EP ': 'ep' }],
        ['labels.en.itemTypes', ['Song', 'VIDEO']],
      ),
    )
    expect(config.labels.en?.albumTypes).toEqual({ single: 'single', ep: 'ep' })
    expect(config.labels.en?.itemTypes).toEqual(['song', 'video'])
  })

  it('keeps labels by language, for the language YouTube answers in', () => {
    const hindi = { albumTypes: { एल्बम: 'album' }, itemTypes: ['गाना'], trackCounts: ['गाने'] }
    const brazil = { albumTypes: { álbum: 'album' }, itemTypes: ['música'], trackCounts: [] }
    const config = parseYouTubeConfig(variant(['labels.hi', hindi], ['labels.pt-BR', brazil]))
    expect(labelsFor(config, 'hi').itemTypes).toEqual(['गाना'])
    expect(labelsFor(config, 'hi-IN').albumTypes).toEqual({ एल्बम: 'album' })
    expect(labelsFor(config, 'pt-BR').itemTypes).toEqual(['música'])
    // A language without labels of its own reads with the English ones, which many share.
    expect(labelsFor(config, 'pt-PT')).toBe(config.labels.en)
    expect(labelsFor(config, 'de')).toBe(config.labels.en)
    expect(labelsFor(BUNDLED_YOUTUBE_CONFIG, 'en-GB')).toBe(BUNDLED_YOUTUBE_CONFIG.labels.en)
  })

  it('turns the Lite tier off with its kill switch, which is off without one', () => {
    expect(parseYouTubeConfig(variant(['killSwitches.lite', true])).killSwitches).toEqual({
      lite: true,
    })
    expect(parseYouTubeConfig(variant(['killSwitches', undefined])).killSwitches).toEqual({
      lite: false,
    })
    expect(
      parseYouTubeConfig(variant(['killSwitches', { lite: false, later: true }])).killSwitches,
    ).toEqual({ lite: false })
  })
})

describe('choosing a config', () => {
  const newer = variant(['revision', BUNDLED_YOUTUBE_CONFIG.revision + 1])

  it('takes a valid candidate with a higher revision', () => {
    const choice = pickYouTubeConfig(newer)
    expect(choice.accepted).toBe(true)
    expect(choice.config.revision).toBe(BUNDLED_YOUTUBE_CONFIG.revision + 1)
  })

  it('keeps the current config for an older, equal or broken candidate, and says why', () => {
    const current: YouTubeConfig = parseYouTubeConfig(newer)
    expect(pickYouTubeConfig(bundled, current)).toMatchObject({
      accepted: false,
      config: current,
      reason: expect.stringContaining('is not newer'),
    })
    expect(pickYouTubeConfig(newer, current).accepted).toBe(false)
    const hostile = variant(['revision', 99], ['clients.music.host', 'evil.example'])
    expect(pickYouTubeConfig(hostile)).toMatchObject({
      accepted: false,
      config: BUNDLED_YOUTUBE_CONFIG,
      reason: expect.stringContaining('clients.music.host'),
    })
    expect(pickYouTubeConfig('{').accepted).toBe(false)
  })
})
