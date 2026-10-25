/**
 * The stream ladder's config: which rungs exist, in which order, which are on, which InnerTube
 * client each one calls and which formats it offers. It lives in the `streams` section of
 * `youtube-config.json`, next to the metadata config of `../config.ts`, so one versioned
 * document (shipped with the app, or a newer one fetched from the static site) can reorder,
 * disable or update the rungs without new code.
 *
 * {@link parseStreamConfig} reads that section of a whole config document. Like the metadata
 * config, it checks every field and refuses any host outside `INNERTUBE_HOSTS`, so a config can
 * change values but never send a request to another host. Stage 1.13 adds signature checks.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import { INNERTUBE_HOSTS, type YouTubeClientConfig } from '../config'
import bundledConfig from '../youtube-config.json'
import { UNAVAILABLE_STATES, type UnavailableState } from './playability'

/**
 * How a rung gets its stream URLs:
 *
 * - `direct` (stage 1.4): one `/player` call whose response carries playable URLs, with no
 *   deciphering, PO token or SABR;
 * - `deciphered`, `attested` and `sabr` (stage 1.11, experimental, see `advanced/README.md`):
 *   URLs deciphered with the player script, the same plus a web PO token, and YouTube's SABR
 *   protocol. The resolver tries them only through its `advanced` hook.
 *
 * Rungs of kinds a build does not know are left out.
 */
export const STREAM_RUNG_KINDS = ['direct', 'deciphered', 'attested', 'sabr'] as const

/** One of the {@link STREAM_RUNG_KINDS}. */
export type StreamRungKind = (typeof STREAM_RUNG_KINDS)[number]

/**
 * The `context.client` fields a stream client may send besides its name and version, such as
 * the device fields of the iOS client. Anything else in a config is refused.
 */
export const STREAM_CLIENT_FIELDS = [
  'deviceMake',
  'deviceModel',
  'osName',
  'osVersion',
  'platform',
  'androidSdkVersion',
  'userAgent',
] as const

/** One of the {@link STREAM_CLIENT_FIELDS}. */
export type StreamClientField = (typeof STREAM_CLIENT_FIELDS)[number]

/** The InnerTube client a rung presents itself as. */
export interface StreamClientConfig extends YouTubeClientConfig {
  /** Extra `context.client` fields, e.g. `{ osName: 'iOS' }`; often none. */
  readonly fields: Readonly<Partial<Record<StreamClientField, string | number>>>
}

/** One rung of the ladder. */
export interface StreamRungConfig {
  /** A stable name for health, memory and diagnostics, e.g. `visionos` or `android-muxed`. */
  readonly id: string
  /** How the rung works. */
  readonly kind: StreamRungKind
  /** Whether the ladder tries it. */
  readonly enabled: boolean
  /** The client its `/player` call presents itself as. */
  readonly client: StreamClientConfig
  /**
   * The formats it offers, by YouTube's format number (itag), most preferred first: Opus 251,
   * then AAC 140, then the smaller ones; `18` is the 360p video with an AAC track.
   */
  readonly itags: readonly number[]
  /**
   * The unavailable states this rung may still try once an earlier rung reported one (see
   * `UnavailableState`). Only such opt-in rungs try them; the others are skipped.
   */
  readonly tries: readonly UnavailableState[]
}

/** A validated, frozen stream config. */
export interface StreamConfig {
  /** The revision of the config document it came from. */
  readonly revision: number
  /**
   * The rungs, in ladder order: the first that yields a playable URL wins. Rungs of a kind
   * this build does not know are left out.
   */
  readonly rungs: readonly StreamRungConfig[]
  /**
   * The bitrate in kbps of the audio track of each muxed format, by itag (as a string, e.g.
   * `'18'`). YouTube's format list gives only the bitrate of the whole file for these.
   */
  readonly muxedAudioKbps: Readonly<Record<string, number>>
}

const RUNG_ID = /^[a-z][a-z0-9-]{1,31}$/u
const CLIENT_NAME = /^[A-Z][A-Z0-9_]{1,40}$/u
const CLIENT_VERSION = /^\d{1,4}(?:\.\d{1,10}){1,4}$/u
const FIELD_TEXT = /^[A-Za-z0-9 ._,;:()/+-]{1,200}$/u
const ITAG_KEY = /^\d{1,3}$/u
const MAX_RUNGS = 16
const MAX_ITAGS = 16

function invalid(path: string, problem: string): never {
  throw new FxmError('Parse', `Invalid YouTube stream config: ${path} ${problem}`)
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(path, 'must be an object')
  }
  return value as Readonly<Record<string, unknown>>
}

function field(object: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined
}

function list(value: unknown, path: string, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    invalid(path, `must be a list of 1 to ${max} entries`)
  }
  return value
}

function text(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(path, `must match ${pattern}`)
  return value
}

function client(value: unknown, path: string): StreamClientConfig {
  const object = record(value, path)
  const host = field(object, 'host')
  if (!(INNERTUBE_HOSTS as readonly unknown[]).includes(host)) {
    invalid(`${path}.host`, `must be one of ${INNERTUBE_HOSTS.join(', ')}`)
  }
  const extra = field(object, 'fields')
  const fields: Partial<Record<StreamClientField, string | number>> = {}
  for (const [name, entry] of Object.entries(extra === undefined ? {} : record(extra, path))) {
    if (!(STREAM_CLIENT_FIELDS as readonly string[]).includes(name)) {
      invalid(`${path}.fields.${name}`, `must be one of ${STREAM_CLIENT_FIELDS.join(', ')}`)
    }
    const ok =
      (typeof entry === 'string' && FIELD_TEXT.test(entry)) ||
      (Number.isSafeInteger(entry) && (entry as number) >= 0 && (entry as number) <= 10_000)
    if (!ok) invalid(`${path}.fields.${name}`, 'must be a short text or a small whole number')
    fields[name as StreamClientField] = entry as string | number
  }
  return {
    name: text(field(object, 'name'), `${path}.name`, CLIENT_NAME),
    version: text(field(object, 'version'), `${path}.version`, CLIENT_VERSION),
    host: host as YouTubeClientConfig['host'],
    fields,
  }
}

function itags(value: unknown, path: string): number[] {
  const values = list(value, path, MAX_ITAGS).map((itag, index) => {
    if (!Number.isSafeInteger(itag) || (itag as number) < 1 || (itag as number) > 999) {
      invalid(`${path}[${index}]`, 'must be a format number from 1 to 999')
    }
    return itag as number
  })
  if (new Set(values).size !== values.length) invalid(path, 'must not repeat a format')
  return values
}

function tries(value: unknown, path: string): UnavailableState[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid(path, 'must be a list')
  const states = value.map((state, index) => {
    if (!(UNAVAILABLE_STATES as readonly unknown[]).includes(state)) {
      invalid(`${path}[${index}]`, `must be one of ${UNAVAILABLE_STATES.join(', ')}`)
    }
    return state as UnavailableState
  })
  if (new Set(states).size !== states.length) invalid(path, 'must not repeat a state')
  return states
}

function rung(value: unknown, path: string): StreamRungConfig | undefined {
  const object = record(value, path)
  const id = text(field(object, 'id'), `${path}.id`, RUNG_ID)
  const kind = field(object, 'kind')
  if (typeof kind !== 'string') invalid(`${path}.kind`, 'must be a text')
  if (!(STREAM_RUNG_KINDS as readonly string[]).includes(kind)) return undefined
  const enabled = field(object, 'enabled')
  if (typeof enabled !== 'boolean') invalid(`${path}.enabled`, 'must be true or false')
  return {
    id,
    kind: kind as StreamRungKind,
    enabled,
    client: client(field(object, 'client'), `${path}.client`),
    itags: itags(field(object, 'itags'), `${path}.itags`),
    tries: tries(field(object, 'tries'), `${path}.tries`),
  }
}

function muxedAudioKbps(value: unknown, path: string): Record<string, number> {
  if (value === undefined) return {}
  return Object.fromEntries(
    Object.entries(record(value, path)).map(([itag, kbps]) => {
      if (!ITAG_KEY.test(itag)) invalid(`${path}.${itag}`, 'must be keyed by a format number')
      if (typeof kbps !== 'number' || !Number.isFinite(kbps) || kbps <= 0 || kbps > 1000) {
        invalid(`${path}.${itag}`, 'must be a bitrate in kbps')
      }
      return [itag, kbps]
    }),
  )
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Reads the `streams` section of a whole YouTube config document, such as
 * `youtube-config.json` or a newer one fetched from the static site, and returns it typed and
 * frozen. Unknown fields are ignored, and so are rungs of a kind this build does not know, so a
 * newer document still loads.
 *
 * @throws FxmError `Parse` naming the first field that is missing or wrong, including a host
 * outside `INNERTUBE_HOSTS`, a repeated rung ID, and a section with no rung this build can use.
 */
export function parseStreamConfig(input: unknown): StreamConfig {
  const root = record(input, 'config')
  const revision = field(root, 'revision')
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    invalid('revision', 'must be a positive integer')
  }
  const streams = record(field(root, 'streams'), 'streams')
  const entries = list(field(streams, 'rungs'), 'streams.rungs', MAX_RUNGS)
  const ids = new Set<string>()
  const rungs: StreamRungConfig[] = []
  for (const [index, entry] of entries.entries()) {
    const path = `streams.rungs[${index}]`
    const id = text(field(record(entry, path), 'id'), `${path}.id`, RUNG_ID)
    if (ids.has(id)) invalid(`${path}.id`, `repeats ${id}`)
    ids.add(id)
    const parsed = rung(entry, path)
    if (parsed !== undefined) rungs.push(parsed)
  }
  if (rungs.length === 0) invalid('streams.rungs', 'has no rung this build can use')
  return deepFreeze({
    revision,
    rungs,
    muxedAudioKbps: muxedAudioKbps(field(streams, 'muxedAudioKbps'), 'streams.muxedAudioKbps'),
  })
}

/** The stream config this build ships with, from `youtube-config.json`. */
export const BUNDLED_STREAM_CONFIG: StreamConfig = parseStreamConfig(bundledConfig)

/** What {@link pickStreamConfig} decided. */
export interface StreamConfigChoice {
  /** The config to use. */
  config: StreamConfig
  /** Whether it is the candidate's. */
  accepted: boolean
  /** Why the candidate was not taken, when it was not. */
  reason?: string
}

/**
 * Chooses between the stream config in use and a candidate document, e.g. one fetched from the
 * static site: the candidate wins only when its `streams` section is valid and its `revision`
 * is higher. It never throws, so a broken or older document leaves the current config in place,
 * and `reason` says why. Hand the same document to `pickYouTubeConfig` for the metadata part.
 */
export function pickStreamConfig(
  candidate: unknown,
  current: StreamConfig = BUNDLED_STREAM_CONFIG,
): StreamConfigChoice {
  let parsed: StreamConfig
  try {
    parsed = parseStreamConfig(candidate)
  } catch (error) {
    return { config: current, accepted: false, reason: (error as Error).message }
  }
  if (parsed.revision <= current.revision) {
    return {
      config: current,
      accepted: false,
      reason: `revision ${parsed.revision} is not newer than ${current.revision}`,
    }
  }
  return { config: parsed, accepted: true }
}
