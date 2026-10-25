import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { BUNDLED_YOUTUBE_CONFIG, parseYouTubeConfig } from '../config'
import bundled from '../youtube-config.json'
import { BUNDLED_STREAM_CONFIG, parseStreamConfig, pickStreamConfig } from './config'

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

function parseError(input: unknown): string {
  try {
    parseStreamConfig(input)
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
    expect(visionos?.client).toEqual({
      name: 'VISIONOS',
      version: '1.02',
      host: 'www.youtube.com',
      fields: {},
    })
    expect(visionos?.itags).toEqual([251, 140, 250, 249, 139])
    expect(ios?.client.fields).toMatchObject({ deviceMake: 'Apple', osName: 'iOS' })
    expect(vr?.client.name).toBe('ANDROID_VR')
    expect(muxed?.client).toMatchObject({ name: 'ANDROID', version: '21.26.364' })
    expect(muxed?.itags).toEqual([18])
    expect(muxed?.tries).toEqual(['made-for-kids'])
    expect(visionos?.tries).toEqual([])
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

  it('refuses client fields it does not know, and odd values', () => {
    const unknown = variant((streams) => {
      ;(firstRung(streams).client as Json).fields = { cookie: 'SID=x' }
    })
    expect(parseError(unknown)).toContain('streams.rungs[0].client.fields.cookie')
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
      [(streams) => (firstRung(streams).tries = ['adult']), 'streams.rungs[0].tries[0]'],
      [(streams) => (firstRung(streams).tries = 'live'), 'streams.rungs[0].tries'],
      [(streams) => (streams.muxedAudioKbps = { '18': -1 }), 'streams.muxedAudioKbps.18'],
      [(streams) => (streams.muxedAudioKbps = { x: 96 }), 'streams.muxedAudioKbps.x'],
      [
        (streams) => ((streams.rungs as Json[])[1] = { ...firstRung(streams) }),
        'streams.rungs[1].id',
      ],
    ]
    for (const [change, path] of cases) expect(parseError(variant(change))).toContain(path)
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
    expect(parseError(none)).toContain('no rung this build can use')
  })

  it('takes a valid, newer document, and keeps the current one otherwise', () => {
    const newer = variant((streams, root) => {
      root.revision = BUNDLED_STREAM_CONFIG.revision + 1
      firstRung(streams).enabled = false
    })
    const taken = pickStreamConfig(newer)
    expect(taken.accepted).toBe(true)
    expect(taken.config.rungs[0]?.enabled).toBe(false)

    const same = pickStreamConfig(variant((streams) => (firstRung(streams).enabled = false)))
    expect(same).toMatchObject({ accepted: false, config: BUNDLED_STREAM_CONFIG })
    expect(same.reason).toContain('not newer')

    const broken = pickStreamConfig({ revision: 99, streams: { rungs: 'all' } })
    expect(broken).toMatchObject({ accepted: false, config: BUNDLED_STREAM_CONFIG })
    expect(broken.reason).toContain('streams.rungs')
  })
})
