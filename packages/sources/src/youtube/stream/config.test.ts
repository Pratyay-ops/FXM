import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { BUNDLED_YOUTUBE_CONFIG, parseYouTubeConfig, pickYouTubeConfig } from '../config'
import bundled from '../youtube-config.json'
import {
  BUNDLED_STREAM_CONFIG,
  BUNDLED_YOUTUBE_CONFIGS,
  invalidStreamConfig,
  parseStreamConfig,
  pickYouTubeConfigs,
  type StreamRungKindParser,
} from './config'

type Json = { [key: string]: unknown }

/** A deep copy of the bundled config document, changed by `change`. */
function variant(change: (streams: Json, root: Json) => void): unknown {
  const copy = structuredClone(bundled) as unknown as Json
  change(copy.streams as Json, copy)
  return copy
}

/** The first rung of a document's `streams` section. */
function firstRung(streams: Json): Json {
  return (streams.rungs as Json[])[0] as Json
}

function parseError(input: unknown, kinds?: readonly StreamRungKindParser[]): string {
  try {
    parseStreamConfig(input, kinds === undefined ? {} : { kinds })
  } catch (error) {
    expect(isFxmError(error, 'Parse')).toBe(true)
    return (error as Error).message
  }
  throw new Error('the config was accepted')
}

describe('the stream config', () => {
  it('ships the ladder: VISIONOS, then itag 18, with ANDROID_VR and IOS listed but off', () => {
    const config = BUNDLED_STREAM_CONFIG
    expect(config.revision).toBe(BUNDLED_YOUTUBE_CONFIG.revision)
    expect(config.rungs.map((rung) => [rung.id, rung.enabled])).toEqual([
      ['visionos', true],
      ['ios', false],
      ['android-vr', false],
      ['android-muxed', true],
    ])
    const [visionos, ios, vr, muxed] = config.rungs
    expect(visionos).toEqual({
      id: 'visionos',
      kind: 'direct',
      enabled: true,
      fallback: false,
      client: { name: 'VISIONOS', version: '1.02', host: 'www.youtube.com', fields: {} },
      itags: [251, 140, 250, 249, 139],
      tries: [],
      requires: { fullAccess: false, mediaBytes: false },
      settings: {},
    })
    expect(ios?.client.fields).toMatchObject({ deviceMake: 'Apple', osName: 'iOS' })
    expect(vr?.client.name).toBe('ANDROID_VR')
    expect(muxed?.client).toMatchObject({ name: 'ANDROID', version: '21.26.364' })
    expect(muxed?.itags).toEqual([18])
    expect(muxed?.tries).toEqual(['made-for-kids'])
    expect(config.rungs.filter((rung) => rung.fallback).map((rung) => rung.id)).toEqual([
      'android-muxed',
    ])
    expect(config.muxedAudioKbps).toEqual({ '18': 128 })
  })

  it('is frozen at every depth', () => {
    const config = BUNDLED_STREAM_CONFIG
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.rungs)).toBe(true)
    expect(Object.isFrozen(config.rungs[0]?.client)).toBe(true)
    expect(() => {
      ;(config.rungs[0] as { enabled: boolean }).enabled = false
    }).toThrow(TypeError)
  })

  it('lives in the same document as the metadata config, which ignores it', () => {
    expect(parseYouTubeConfig(bundled)).toEqual(BUNDLED_YOUTUBE_CONFIG)
    expect('streams' in BUNDLED_YOUTUBE_CONFIG).toBe(false)
  })

  it('refuses hosts outside the InnerTube allowlist', () => {
    const input = variant((streams) => {
      ;(firstRung(streams).client as Json).host = 'evil.example'
    })
    expect(parseError(input)).toContain('streams.rungs[0].client.host')
  })

  it('refuses a document of another schema, as the metadata config does', () => {
    const newer = variant((_, root) => {
      root.schema = 2
      root.revision = BUNDLED_STREAM_CONFIG.revision + 1
    })
    expect(parseError(newer)).toContain('schema')
    expect(pickYouTubeConfig(newer).accepted).toBe(false)
    expect(pickYouTubeConfigs(newer)).toMatchObject({ accepted: false })
    expect(parseError(variant((_, root) => delete root.schema))).toContain('schema')
  })

  it('leaves out a rung whose client sends a field this build does not know', () => {
    const unknown = variant((streams) => {
      ;(firstRung(streams).client as Json).fields = { osName: 'visionOS', cookie: 'SID=x' }
    })
    expect(parseStreamConfig(unknown).rungs.map((rung) => rung.id)).toEqual([
      'ios',
      'android-vr',
      'android-muxed',
    ])
    const malformed = variant((streams) => {
      ;(firstRung(streams).client as Json).fields = { 'os name': 'x' }
    })
    expect(parseError(malformed)).toContain('streams.rungs[0].client.fields')
  })

  it('refuses odd values of the client fields it knows', () => {
    const odd = variant((streams) => {
      ;(firstRung(streams).client as Json).fields = { osName: 'iOS\n<script>' }
    })
    expect(parseError(odd)).toContain('fields.osName')
    const big = variant((streams) => {
      ;(firstRung(streams).client as Json).fields = { androidSdkVersion: 1e9 }
    })
    expect(parseError(big)).toContain('fields.androidSdkVersion')
  })

  it('refuses malformed names, versions, formats, states and IDs', () => {
    const cases: [change: (streams: Json, root: Json) => void, path: string][] = [
      [(_, root) => delete root.streams, 'streams'],
      [(_, root) => (root.revision = 0), 'revision'],
      [(streams) => (streams.rungs = []), 'streams.rungs'],
      [(streams) => (firstRung(streams).id = 'VisionOS'), 'streams.rungs[0].id'],
      [(streams) => ((firstRung(streams).client as Json).name = 'visionos'), 'client.name'],
      [(streams) => ((firstRung(streams).client as Json).version = 'latest'), 'client.version'],
      [(streams) => (firstRung(streams).itags = []), 'streams.rungs[0].itags'],
      [(streams) => (firstRung(streams).itags = [251, 251]), 'streams.rungs[0].itags'],
      [(streams) => (firstRung(streams).itags = [0]), 'streams.rungs[0].itags[0]'],
      [(streams) => (firstRung(streams).enabled = 'yes'), 'streams.rungs[0].enabled'],
      [(streams) => (firstRung(streams).fallback = 'yes'), 'streams.rungs[0].fallback'],
      [(streams) => (firstRung(streams).kind = 7), 'streams.rungs[0].kind'],
      [(streams) => (firstRung(streams).tries = ['Live']), 'streams.rungs[0].tries[0]'],
      [(streams) => (firstRung(streams).tries = [7]), 'streams.rungs[0].tries[0]'],
      [(streams) => (firstRung(streams).tries = ['live', 'live']), 'streams.rungs[0].tries'],
      [(streams) => (firstRung(streams).tries = 'live'), 'streams.rungs[0].tries'],
      [(streams) => (firstRung(streams).requires = []), 'streams.rungs[0].requires'],
      [
        (streams) => (firstRung(streams).requires = { mediaBytes: 'yes' }),
        'streams.rungs[0].requires.mediaBytes',
      ],
      [
        (streams) => (firstRung(streams).requires = { platforms: ['web', 'web'] }),
        'streams.rungs[0].requires.platforms',
      ],
      [
        (streams) => (firstRung(streams).requires = { platforms: 'web' }),
        'streams.rungs[0].requires.platforms',
      ],
      [(streams) => (streams.muxedAudioKbps = { '18': -1 }), 'streams.muxedAudioKbps.18'],
      [(streams) => (streams.muxedAudioKbps = { x: 96 }), 'streams.muxedAudioKbps.x'],
      [
        (streams) => ((streams.rungs as Json[])[1] = { ...firstRung(streams) }),
        'streams.rungs[1].id',
      ],
    ]
    for (const [change, path] of cases) expect(parseError(variant(change))).toContain(path)
  })

  it('ignores states this build does not know, so only known opt-ins remain', () => {
    const newer = variant((streams) => {
      ;(streams.rungs as Json[])[3] = {
        ...((streams.rungs as Json[])[3] as Json),
        tries: ['made-for-kids', 'members-only'],
      }
    })
    expect(parseStreamConfig(newer).rungs[3]?.tries).toEqual(['made-for-kids'])
  })

  it('reads where a rung may run, and leaves out one that needs what this build cannot check', () => {
    const limited = variant((streams) => {
      firstRung(streams).requires = { platforms: ['web', 'desktop'], fullAccess: true }
    })
    expect(parseStreamConfig(limited).rungs[0]?.requires).toEqual({
      platforms: ['web', 'desktop'],
      fullAccess: true,
      mediaBytes: false,
    })
    const unknown = variant((streams) => {
      firstRung(streams).requires = { mediaBytes: true, evaluator: 'v2' }
    })
    expect(parseStreamConfig(unknown).rungs.map((rung) => rung.id)).not.toContain('visionos')
  })

  it('allows one last-resort rung at most', () => {
    const two = variant((streams) => {
      firstRung(streams).fallback = true
    })
    expect(parseError(two)).toContain('streams.rungs[3].fallback')
    const none = variant((streams) => {
      for (const rung of streams.rungs as Json[]) delete rung.fallback
    })
    expect(parseStreamConfig(none).rungs.some((rung) => rung.fallback)).toBe(false)
  })

  it('reads the settings of the kinds a build adds, and leaves out rungs they cannot use', () => {
    const tv: StreamRungKindParser = {
      kind: 'tv',
      parseSettings(raw, path) {
        if (raw === undefined) return {}
        const timestamp = (raw as Json).signatureTimestamp
        if (timestamp === 'later') return undefined
        if (!Number.isSafeInteger(timestamp)) invalidStreamConfig(`${path}.signatureTimestamp`, 'x')
        return { signatureTimestamp: timestamp as number }
      },
    }
    const entry = (settings: unknown): Json => ({
      ...firstRung(bundled.streams as unknown as Json),
      id: 'tv-deciphered',
      kind: 'tv',
      settings,
    })
    const withTv = (settings: unknown) =>
      variant((streams) => (streams.rungs as Json[]).splice(1, 0, entry(settings)))
    const parsed = parseStreamConfig(withTv({ signatureTimestamp: 20_000 }), { kinds: [tv] })
    expect(parsed.rungs[1]).toMatchObject({
      id: 'tv-deciphered',
      kind: 'tv',
      settings: { signatureTimestamp: 20_000 },
    })
    expect(Object.isFrozen(parsed.rungs[1]?.settings)).toBe(true)
    // Without the kind, its rungs are left out; with it, settings it can't use leave one out.
    expect(parseStreamConfig(withTv({})).rungs.map((rung) => rung.id)).not.toContain(
      'tv-deciphered',
    )
    const later = parseStreamConfig(withTv({ signatureTimestamp: 'later' }), { kinds: [tv] })
    expect(later.rungs.map((rung) => rung.id)).not.toContain('tv-deciphered')
    expect(parseError(withTv({ signatureTimestamp: 1.5 }), [tv])).toContain(
      'streams.rungs[1].settings.signatureTimestamp',
    )
  })

  it('leaves out rungs of kinds this build does not know, and needs one it does', () => {
    const newer = variant((streams) => {
      ;(streams.rungs as Json[]).splice(1, 0, {
        id: 'tv-deciphered',
        kind: 'deciphered',
        enabled: true,
        future: { anything: 1 },
      })
    })
    expect(parseStreamConfig(newer).rungs.map((rung) => rung.id)).toEqual([
      'visionos',
      'ios',
      'android-vr',
      'android-muxed',
    ])
    const none = variant((streams) => {
      for (const rung of streams.rungs as Json[]) rung.kind = 'sabr'
    })
    expect(parseError(none)).toContain('no rung this build can run')
  })

  it('takes both parts of a valid, newer document together, and keeps the current ones otherwise', () => {
    const newer = variant((streams, root) => {
      root.revision = BUNDLED_STREAM_CONFIG.revision + 1
      firstRung(streams).enabled = false
      ;(root.radio as Json).params = 'wAEC'
    })
    const taken = pickYouTubeConfigs(newer)
    expect(taken.accepted).toBe(true)
    expect(taken.configs.streams.rungs[0]?.enabled).toBe(false)
    expect(taken.configs.metadata.radio.params).toBe('wAEC')
    expect(taken.configs.streams.revision).toBe(taken.configs.metadata.revision)

    const same = pickYouTubeConfigs(variant((streams) => (firstRung(streams).enabled = false)))
    expect(same).toMatchObject({ accepted: false, configs: BUNDLED_YOUTUBE_CONFIGS })
    expect(same.reason).toContain('not newer')

    // A newer document whose streams are broken changes neither part, and nor does one whose
    // metadata part is broken.
    const brokenStreams = variant((streams, root) => {
      root.revision = BUNDLED_STREAM_CONFIG.revision + 1
      streams.rungs = 'all'
    })
    expect(pickYouTubeConfig(brokenStreams).accepted).toBe(true)
    const refused = pickYouTubeConfigs(brokenStreams)
    expect(refused).toMatchObject({ accepted: false, configs: BUNDLED_YOUTUBE_CONFIGS })
    expect(refused.reason).toContain('streams.rungs')
    const brokenMetadata = variant((_, root) => {
      root.revision = BUNDLED_STREAM_CONFIG.revision + 1
      root.defaultHost = 'evil.example'
    })
    expect(pickYouTubeConfigs(brokenMetadata)).toMatchObject({ accepted: false })
  })
})
