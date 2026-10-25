import { describe, expect, it, vi } from 'vitest'
import type { StreamOption } from '../providers'
import { DEFAULT_QUALITY_PREFS, type FullLengthCheck, type QualityPrefs } from '../quality'
import {
  CONNECTION_PREFERENCES,
  connectionFromType,
  DATA_SAVER_CEILING,
  DEFAULT_STREAMING_SETTINGS,
  type DetectedConnection,
  isConnectionPreference,
  type ProbePlan,
  probeChosenStream,
  type StreamingProfile,
  type StreamingSettings,
  sanitizeStreamingSettings,
  streamingProfile,
} from './quality-settings'
import { choosePlaybackStream, type StreamSupport } from './streams'

describe('connectionFromType', () => {
  it.each<[unknown, DetectedConnection]>([
    ['wifi', 'wifi'],
    ['ethernet', 'wifi'],
    ['cellular', 'cellular'],
    ['bluetooth', 'unknown'],
    ['wimax', 'unknown'],
    ['mixed', 'unknown'],
    ['none', 'unknown'],
    ['other', 'unknown'],
    ['unknown', 'unknown'],
    ['Cellular', 'unknown'],
    [undefined, 'unknown'],
    [null, 'unknown'],
    [3, 'unknown'],
  ])('reads %s as %s', (type, expected) => {
    expect(connectionFromType(type)).toBe(expected)
  })
})

describe('streaming settings', () => {
  it('follow the detected connection with the data saver off by default, frozen', () => {
    expect(DEFAULT_STREAMING_SETTINGS).toEqual({ connection: 'auto', dataSaver: false })
    expect(Object.isFrozen(DEFAULT_STREAMING_SETTINGS)).toBe(true)
    expect(CONNECTION_PREFERENCES).toEqual(['auto', 'wifi', 'cellular'])
    expect(Object.isFrozen(CONNECTION_PREFERENCES)).toBe(true)
  })

  it.each([
    ['auto', true],
    ['wifi', true],
    ['cellular', true],
    ['ethernet', false],
    ['Auto', false],
    ['toString', false],
    [undefined, false],
  ])('recognize the connection preference %s: %s', (value, expected) => {
    expect(isConnectionPreference(value)).toBe(expected)
  })

  it('keep valid stored values and drop unknown fields', () => {
    const stored = { connection: 'cellular', dataSaver: true, theme: 'dark' }
    expect(sanitizeStreamingSettings(stored)).toEqual({ connection: 'cellular', dataSaver: true })
  })

  it('replace each invalid field on its own', () => {
    expect(sanitizeStreamingSettings({ connection: 'ethernet', dataSaver: true })).toEqual({
      connection: 'auto',
      dataSaver: true,
    })
    expect(sanitizeStreamingSettings({ connection: 'wifi', dataSaver: 'yes' })).toEqual({
      connection: 'wifi',
      dataSaver: false,
    })
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'cellular'],
    ['an array', ['cellular', true]],
    ['fields of the wrong type', { connection: 1, dataSaver: 1 }],
  ])('fall back to the defaults for %s', (_label, value) => {
    expect(sanitizeStreamingSettings(value)).toEqual(DEFAULT_STREAMING_SETTINGS)
  })

  it('return a fresh, mutable object and never read inherited fields', () => {
    const settings = sanitizeStreamingSettings(undefined)
    settings.dataSaver = true
    expect(DEFAULT_STREAMING_SETTINGS.dataSaver).toBe(false)
    const inherited = Object.create({ connection: 'cellular', dataSaver: true }) as object
    expect(sanitizeStreamingSettings(inherited)).toEqual(DEFAULT_STREAMING_SETTINGS)
  })
})

describe('streamingProfile', () => {
  const prefs: QualityPrefs = {
    streaming: { wifi: 'lossless', cellular: 'normal' },
    download: { format: 'original' },
  }
  const settings = (overrides: Partial<StreamingSettings> = {}): StreamingSettings => ({
    ...DEFAULT_STREAMING_SETTINGS,
    ...overrides,
  })

  it.each<[string, Partial<StreamingSettings>, DetectedConnection, Partial<StreamingProfile>]>([
    [
      'follows a detected Wi-Fi network',
      {},
      'wifi',
      { connection: 'wifi', basis: 'detected', ceiling: 'lossless', preferAudioOnly: false },
    ],
    [
      'follows detected mobile data, audio only first',
      {},
      'cellular',
      { connection: 'cellular', basis: 'detected', ceiling: 'normal', preferAudioOnly: true },
    ],
    [
      'assumes Wi-Fi when the platform cannot tell',
      {},
      'unknown',
      { connection: 'wifi', basis: 'assumed', ceiling: 'lossless', preferAudioOnly: false },
    ],
    [
      'takes the mobile-data ceiling the user chose on a network detected as Wi-Fi',
      { connection: 'cellular' },
      'wifi',
      { connection: 'cellular', basis: 'chosen', ceiling: 'normal', preferAudioOnly: true },
    ],
    [
      'takes the Wi-Fi ceiling the user chose on detected mobile data',
      { connection: 'wifi' },
      'cellular',
      { connection: 'wifi', basis: 'chosen', ceiling: 'lossless', preferAudioOnly: false },
    ],
    [
      'takes the user’s choice where the platform cannot tell',
      { connection: 'cellular' },
      'unknown',
      { connection: 'cellular', basis: 'chosen', ceiling: 'normal', preferAudioOnly: true },
    ],
  ])('%s', (_label, overrides, detected, expected) => {
    expect(streamingProfile(prefs, settings(overrides), detected)).toEqual({
      probe: 'default',
      ...expected,
    })
  })

  it('streams at Low on every connection with the data saver, audio only first, probing one stream', () => {
    const saver = settings({ dataSaver: true })
    expect(DATA_SAVER_CEILING).toBe('low')
    for (const detected of ['wifi', 'cellular', 'unknown'] as const) {
      expect(streamingProfile(prefs, saver, detected)).toMatchObject({
        ceiling: 'low',
        preferAudioOnly: true,
        probe: 'chosen',
      })
    }
    expect(streamingProfile(prefs, { connection: 'cellular', dataSaver: true }, 'wifi')).toEqual({
      connection: 'cellular',
      basis: 'chosen',
      ceiling: 'low',
      preferAudioOnly: true,
      probe: 'chosen',
    })
  })

  it('accepts the frozen defaults', () => {
    expect(streamingProfile(DEFAULT_QUALITY_PREFS, DEFAULT_STREAMING_SETTINGS, 'cellular')).toEqual(
      {
        connection: 'cellular',
        basis: 'detected',
        ceiling: 'normal',
        preferAudioOnly: true,
        probe: 'default',
      },
    )
  })

  it('fails closed on values the types rule out', () => {
    const broken = {
      streaming: { wifi: 'ultra', cellular: 'toString' },
    } as unknown as QualityPrefs
    const odd = { connection: 'toString', dataSaver: 'yes' } as unknown as StreamingSettings
    expect(streamingProfile(broken, odd, 'valueOf' as DetectedConnection)).toEqual({
      connection: 'wifi',
      basis: 'assumed',
      ceiling: 'high',
      preferAudioOnly: false,
      probe: 'default',
    })
    expect(streamingProfile(broken, settings({ connection: 'cellular' }), 'wifi').ceiling).toBe(
      'normal',
    )
  })
})

/** A stream named after its itag, as the YouTube ladder resolves it, before any probe. */
function stream(itag: number, overrides: Partial<StreamOption> = {}): StreamOption {
  return {
    url: `https://media.test/${itag}`,
    codec: 'opus',
    container: 'webm',
    media: 'audio',
    bitrateKbps: 150,
    tier: 'high',
    protocol: 'progressive',
    ipBound: true,
    fullLength: 'unverified',
    ...overrides,
  }
}

const opus251 = stream(251)
const aac140 = stream(140, { codec: 'aac', container: 'm4a', bitrateKbps: 130 })
const opus250 = stream(250, { bitrateKbps: 70, tier: 'normal' })
const opus249 = stream(249, { bitrateKbps: 50, tier: 'low' })
const aac139 = stream(139, { codec: 'aac', container: 'm4a', bitrateKbps: 48, tier: 'low' })
const visionos = [opus251, aac140, opus250, opus249, aac139]

/** A fake end-of-file probe: what each URL answers, `verified` unless listed. */
function fakeProbe(answers: Record<string, FullLengthCheck> = {}) {
  const probed: string[] = []
  const probe = vi.fn(async (option: StreamOption) => {
    probed.push(option.url.replace('https://media.test/', ''))
    return { ...option, fullLength: answers[option.url] ?? 'verified' }
  })
  return { probe, probed }
}

/** Chooses as playback does, under `ceiling`, with the player's `support` and `exclude`. */
function playbackChoice(
  ceiling: StreamingProfile['ceiling'],
  support: (option: StreamOption) => StreamSupport = () => 'probably',
  exclude: (option: StreamOption) => boolean = () => false,
): ProbePlan['choose'] {
  return (options) =>
    choosePlaybackStream(options, { support, ceiling, preferAudioOnly: true, exclude })
}

const fullLengths = (options: readonly StreamOption[]) =>
  options.map((option) => `${option.url.replace('https://media.test/', '')}:${option.fullLength}`)

describe('probeChosenStream', () => {
  it('probes only the stream playback would choose', async () => {
    const { probe, probed } = fakeProbe()
    const { options, outcome } = await probeChosenStream(visionos, playbackChoice('low'), probe)
    expect(probed).toEqual(['249'])
    expect(outcome).toBe('playable')
    expect(fullLengths(options)).toEqual([
      '251:unverified',
      '140:unverified',
      '250:unverified',
      '249:verified',
      '139:unverified',
    ])
    expect(options[0]).toBe(opus251)
  })

  it('follows the player’s formats: AAC where it only may play Opus', async () => {
    const { probe, probed } = fakeProbe()
    const support = (option: StreamOption): StreamSupport =>
      option.codec === 'opus' ? 'maybe' : 'probably'
    await probeChosenStream(visionos, playbackChoice('high', support), probe)
    expect(probed).toEqual(['140'])
  })

  it('probes the next choice while a probe finds the chosen URL capped', async () => {
    const { probe, probed } = fakeProbe({ [opus249.url]: 'capped' })
    const { options, outcome } = await probeChosenStream(visionos, playbackChoice('low'), probe)
    expect(probed).toEqual(['249', '139'])
    expect(outcome).toBe('playable')
    expect(fullLengths(options)).toContain('249:capped')
    expect(fullLengths(options)).toContain('139:verified')
  })

  it('ends at a probe that cannot tell, which leaves the URL playable', async () => {
    const { probe, probed } = fakeProbe({ [opus249.url]: 'unverified' })
    const { outcome } = await probeChosenStream(visionos, playbackChoice('low'), probe)
    expect(probed).toEqual(['249'])
    expect(outcome).toBe('playable')
  })

  it('reports the rung capped when every choice a probe tried was capped', async () => {
    const capped = Object.fromEntries(visionos.map(({ url }) => [url, 'capped' as const]))
    const { probe, probed } = fakeProbe(capped)
    const choose = playbackChoice('low')
    const { options, outcome } = await probeChosenStream(visionos, choose, probe)
    expect(probed).toEqual(['249', '139', '250', '140', '251'])
    expect(outcome).toBe('capped')
    expect(options.every((option) => option.fullLength === 'capped')).toBe(true)
    expect(choose(options)).toBeUndefined()
  })

  it('reports the rung capped when the formats left after a capped probe already failed', async () => {
    const { probe, probed } = fakeProbe({ [opus249.url]: 'capped' })
    // AAC did not decode earlier, and Opus 250 and 251 failed on this network.
    const exclude = (option: StreamOption) => option.codec === 'aac' || option.tier !== 'low'
    const { outcome } = await probeChosenStream(
      visionos,
      playbackChoice('low', undefined, exclude),
      probe,
    )
    expect(probed).toEqual(['249'])
    expect(outcome).toBe('capped')
  })

  it('reports nothing chosen, and probes nothing, when playback would choose nothing', async () => {
    const { probe } = fakeProbe()
    const nothing = await probeChosenStream(visionos, () => undefined, probe)
    expect(nothing).toEqual({ options: visionos, outcome: 'nothing-chosen' })
    // Every format already failed to decode, or the player can play none of them.
    const failed = await probeChosenStream(
      visionos,
      playbackChoice('low', undefined, () => true),
      probe,
    )
    const unplayable = await probeChosenStream(
      visionos,
      playbackChoice('low', () => 'no'),
      probe,
    )
    expect([failed.outcome, unplayable.outcome]).toEqual(['nothing-chosen', 'nothing-chosen'])
    expect(await probeChosenStream([], playbackChoice('high'), probe)).toEqual({
      options: [],
      outcome: 'nothing-chosen',
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('never counts a cap it did not find: options capped before it are not its own', async () => {
    const { probe } = fakeProbe()
    const cappedBefore = visionos.map((option) => ({ ...option, fullLength: 'capped' as const }))
    const { outcome } = await probeChosenStream(cappedBefore, playbackChoice('low'), probe)
    expect(outcome).toBe('nothing-chosen')
    expect(probe).not.toHaveBeenCalled()
  })

  it('takes an option already verified as it is', async () => {
    const { probe } = fakeProbe()
    const verified = [{ ...opus251, fullLength: 'verified' as const }, aac140]
    const result = await probeChosenStream(verified, playbackChoice('high'), probe)
    expect(result).toEqual({ options: verified, outcome: 'playable' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('never probes a stream that is not a file, such as HLS', async () => {
    const { probe } = fakeProbe()
    const hls = stream(91, { protocol: 'hls', bitrateKbps: 48, tier: 'low' })
    const { options, outcome } = await probeChosenStream(
      [opus251, hls],
      playbackChoice('low'),
      probe,
    )
    expect(outcome).toBe('playable')
    expect(options).toEqual([opus251, hls])
    expect(probe).not.toHaveBeenCalled()
  })

  it('never probes a capped option or one `choose` was not given', async () => {
    const { probe, probed } = fakeProbe()
    const cappedFirst = [{ ...opus249, fullLength: 'capped' as const }, aac139]
    await probeChosenStream(cappedFirst, playbackChoice('low'), probe)
    expect(probed).toEqual(['139'])
    const stranger = <T extends StreamOption>() => ({ ...opus251 }) as T
    const { outcome } = await probeChosenStream(visionos, stranger, probe)
    expect(outcome).toBe('nothing-chosen')
    expect(probed).toEqual(['139'])
  })

  it('passes on a rejected probe, such as the caller’s cancellation', async () => {
    const cancelled = Object.assign(new Error('Cancelled'), { name: 'AbortError' })
    const probe = () => Promise.reject(cancelled)
    await expect(probeChosenStream(visionos, playbackChoice('low'), probe)).rejects.toBe(cancelled)
  })
})
