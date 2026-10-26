/**
 * The stream ladder's config: which rungs exist, in which order, which are on, how each one works
 * (its kind), which InnerTube client it calls, which formats it offers, where it may run and
 * which one is the last resort. It lives in the `streams` section of `youtube-config.json`, next
 * to the metadata config of `../config.ts`, so one versioned document (shipped with the app, or a
 * newer signed one fetched from the static site) can reorder, disable or update the rungs without
 * new code. {@link pickYouTubeConfigs} decides on both parts of a new document at once.
 *
 * {@link parseStreamConfig} checks every field it reads and refuses any host outside
 * `INNERTUBE_HOSTS`, so a config can change values but never send a request to another host. A
 * newer document of the same schema still loads in an older build: a rung that build can't run
 * (a kind, client field or requirement it doesn't know) is left out, a state it doesn't know is
 * ignored, and so are fields it doesn't read. A config from the network must have its signature
 * checked first: the apps take one only through `youtube/module`'s host.
 *
 * @module
 */

import { FxmError, type JsonObject } from '@fxm/core'
import {
  BUNDLED_YOUTUBE_CONFIG,
  INNERTUBE_HOSTS,
  parseYouTubeConfig,
  YOUTUBE_CONFIG_SCHEMA,
  type YouTubeClientConfig,
  type YouTubeConfig,
} from '../config'
import bundledConfig from '../youtube-config.json'
import { UNAVAILABLE_STATES, type UnavailableState } from './playability'

/**
 * The `context.client` fields a stream client may send besides its name and version, such as
 * the device fields of the iOS client. A rung whose client names another field is left out.
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

/**
 * Where a rung may run. A rung whose requirements a context doesn't meet is left out of that
 * resolution, e.g. a deciphering rung in the Lite tier.
 */
export interface StreamRungRequirements {
  /** The platforms it may run on, e.g. `['web', 'desktop']`; every platform when absent. */
  readonly platforms?: readonly string[]
  /**
   * Whether it needs `full` YouTube access, which the Lite tier lacks: e.g. to read YouTube's
   * player JS for deciphering.
   */
  readonly fullAccess: boolean
  /** Whether it needs googlevideo's bytes (`capabilities.mediaBytes`), e.g. for SABR. */
  readonly mediaBytes: boolean
}

/** One rung of the ladder. */
export interface StreamRungConfig {
  /** A stable name for health, memory and diagnostics, e.g. `visionos` or `android-muxed`. */
  readonly id: string
  /**
   * How the rung works: `direct` (stage 1.4), one `/player` call whose answer carries playable
   * URLs, or a kind a build adds (see `StreamRungKind` in `kinds.ts`).
   */
  readonly kind: string
  /** Whether the ladder tries it. */
  readonly enabled: boolean
  /**
   * Whether it is the ladder's last resort, which `resolve`'s `rungs: 'fallback'` asks for:
   * itag 18 in the bundled config. At most one rung is.
   */
  readonly fallback: boolean
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
  /** Where it may run. */
  readonly requires: StreamRungRequirements
  /** The settings of its kind, as the kind's `parseSettings` read them; none for `direct`. */
  readonly settings: JsonObject
}

/** A validated, frozen stream config. */
export interface StreamConfig {
  /** The revision of the config document it came from. */
  readonly revision: number
  /**
   * The rungs, in ladder order: the first that yields a playable URL wins. Rungs this build
   * can't run are left out.
   */
  readonly rungs: readonly StreamRungConfig[]
  /**
   * The bitrate in kbps of the audio track of each muxed format, by itag (as a string, e.g.
   * `'18'`). YouTube's format list gives only the bitrate of the whole file for these.
   */
  readonly muxedAudioKbps: Readonly<Record<string, number>>
}

/**
 * How the config reads the rungs of one kind. `direct` is built in; a build that runs more
 * kinds passes their readers to {@link parseStreamConfig} (the `StreamRungKind`s of `kinds.ts`
 * are readers too).
 */
export interface StreamRungKindParser {
  /** The `kind` it reads, e.g. `direct`. */
  readonly kind: string
  /**
   * Reads the `settings` of a rung of this kind (`undefined` when the entry has none), with
   * `path` for error messages. Returns them as JSON, or `undefined` when this build can't use
   * the rung, which leaves it out; throws {@link invalidStreamConfig} for a malformed value,
   * which refuses the document. Without it, a rung of the kind has no settings.
   */
  readonly parseSettings?: (raw: unknown, path: string) => JsonObject | undefined
}

/** Options for {@link parseStreamConfig}. */
export interface StreamConfigOptions {
  /**
   * The kinds this build runs besides `direct`, e.g. stage 1.11's. Rungs of other kinds are
   * left out. Pass the same kinds to `createYouTubeAudioSource`'s `rungKinds`.
   */
  readonly kinds?: readonly StreamRungKindParser[]
}

const RUNG_ID = /^[a-z][a-z0-9-]{1,31}$/u
const KIND_NAME = /^[a-z][a-z0-9-]{1,31}$/u
const STATE_NAME = /^[a-z][a-z0-9-]{1,31}$/u
const PLATFORM_NAME = /^[a-z]{1,16}$/u
const CLIENT_NAME = /^[A-Z][A-Z0-9_]{1,40}$/u
const CLIENT_VERSION = /^\d{1,4}(?:\.\d{1,10}){1,4}$/u
const FIELD_NAME = /^[a-z][A-Za-z0-9]{1,40}$/u
const FIELD_TEXT = /^[A-Za-z0-9 ._,;:()/+-]{1,200}$/u
const ITAG_KEY = /^\d{1,3}$/u
const MAX_RUNGS = 16
const MAX_ITAGS = 16
const MAX_STATES = 16
const MAX_PLATFORMS = 8

/** The keys of `requires` this build understands. A rung that names another is left out. */
const REQUIREMENT_KEYS: readonly string[] = ['platforms', 'fullAccess', 'mediaBytes']

/** The reader of `direct` rungs: they have no settings of their own. */
const DIRECT_READER: StreamRungKindParser = Object.freeze({ kind: 'direct' })

/**
 * Refuses a stream config, naming the field at `path` and what is wrong with it. Kind readers
 * throw it from `parseSettings` for a malformed value.
 *
 * @throws FxmError `Parse`, always.
 */
export function invalidStreamConfig(path: string, problem: string): never {
  throw new FxmError('Parse', `Invalid YouTube stream config: ${path} ${problem}`)
}

const invalid: (path: string, problem: string) => never = invalidStreamConfig

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

/** An optional true or false, `false` when absent. */
function flag(value: unknown, path: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') invalid(path, 'must be true or false')
  return value
}

/** A list of distinct names, each matching `pattern`. */
function names(value: unknown, path: string, pattern: RegExp, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) {
    invalid(path, `must be a list of at most ${max} names`)
  }
  const found = value.map((name, index) => text(name, `${path}[${index}]`, pattern))
  if (new Set(found).size !== found.length) invalid(path, 'must not repeat a name')
  return found
}

/** The rung's client, or `undefined` when it sends a field this build doesn't know. */
function client(value: unknown, path: string): StreamClientConfig | undefined {
  const object = record(value, path)
  const host = field(object, 'host')
  if (!(INNERTUBE_HOSTS as readonly unknown[]).includes(host)) {
    invalid(`${path}.host`, `must be one of ${INNERTUBE_HOSTS.join(', ')}`)
  }
  const name = text(field(object, 'name'), `${path}.name`, CLIENT_NAME)
  const version = text(field(object, 'version'), `${path}.version`, CLIENT_VERSION)
  const extra = field(object, 'fields')
  const fields: Partial<Record<StreamClientField, string | number>> = {}
  let usable = true
  for (const [key, entry] of Object.entries(
    extra === undefined ? {} : record(extra, `${path}.fields`),
  )) {
    if (!(STREAM_CLIENT_FIELDS as readonly string[]).includes(key)) {
      // A field this build doesn't know: it can't send the client as the config means it.
      if (!FIELD_NAME.test(key)) invalid(`${path}.fields`, `has a malformed field name`)
      usable = false
      continue
    }
    const ok =
      (typeof entry === 'string' && FIELD_TEXT.test(entry)) ||
      (Number.isSafeInteger(entry) && (entry as number) >= 0 && (entry as number) <= 10_000)
    if (!ok) invalid(`${path}.fields.${key}`, 'must be a short text or a small whole number')
    fields[key as StreamClientField] = entry as string | number
  }
  return usable ? { name, version, host: host as YouTubeClientConfig['host'], fields } : undefined
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

/** The states a rung opts in to. A state this build doesn't know is ignored. */
function tries(value: unknown, path: string): UnavailableState[] {
  if (value === undefined) return []
  return names(value, path, STATE_NAME, MAX_STATES).filter((state): state is UnavailableState =>
    (UNAVAILABLE_STATES as readonly string[]).includes(state),
  )
}

/** Where a rung may run, or `undefined` when it names a requirement this build doesn't know. */
function requirements(value: unknown, path: string): StreamRungRequirements | undefined {
  if (value === undefined) return { fullAccess: false, mediaBytes: false }
  const object = record(value, path)
  if (Object.keys(object).some((key) => !REQUIREMENT_KEYS.includes(key))) return undefined
  const platforms = field(object, 'platforms')
  return {
    ...(platforms === undefined
      ? {}
      : { platforms: names(platforms, `${path}.platforms`, PLATFORM_NAME, MAX_PLATFORMS) }),
    fullAccess: flag(field(object, 'fullAccess'), `${path}.fullAccess`),
    mediaBytes: flag(field(object, 'mediaBytes'), `${path}.mediaBytes`),
  }
}

/** A rung of a kind this build runs, or `undefined` when this build can't run it as written. */
function rung(
  object: Readonly<Record<string, unknown>>,
  path: string,
  base: Pick<StreamRungConfig, 'id' | 'kind' | 'fallback'>,
  reader: StreamRungKindParser,
): StreamRungConfig | undefined {
  const enabled = field(object, 'enabled')
  if (typeof enabled !== 'boolean') invalid(`${path}.enabled`, 'must be true or false')
  const parsedClient = client(field(object, 'client'), `${path}.client`)
  const parsedItags = itags(field(object, 'itags'), `${path}.itags`)
  const parsedTries = tries(field(object, 'tries'), `${path}.tries`)
  const requires = requirements(field(object, 'requires'), `${path}.requires`)
  const settings =
    reader.parseSettings === undefined
      ? {}
      : reader.parseSettings(field(object, 'settings'), `${path}.settings`)
  if (parsedClient === undefined || requires === undefined || settings === undefined) {
    return undefined
  }
  return {
    ...base,
    enabled,
    client: parsedClient,
    itags: parsedItags,
    tries: parsedTries,
    requires,
    settings,
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
 * frozen. A newer document of the same schema still loads: rungs this build can't run (a kind
 * not in `options.kinds` or `direct`, a client field outside {@link STREAM_CLIENT_FIELDS}, a
 * requirement it doesn't know, or settings its kind refuses to use) are left out, states it
 * doesn't know are ignored, and so are fields it doesn't read.
 *
 * @throws FxmError `Parse` naming the first field that is malformed, including a `schema` other
 * than `YOUTUBE_CONFIG_SCHEMA`, a host outside `INNERTUBE_HOSTS`, a repeated rung ID, a second
 * last-resort rung, and a section with no rung this build can run.
 */
export function parseStreamConfig(input: unknown, options: StreamConfigOptions = {}): StreamConfig {
  const root = record(input, 'config')
  if (field(root, 'schema') !== YOUTUBE_CONFIG_SCHEMA) {
    invalid('schema', `must be ${YOUTUBE_CONFIG_SCHEMA}`)
  }
  const revision = field(root, 'revision')
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    invalid('revision', 'must be a positive integer')
  }
  const streams = record(field(root, 'streams'), 'streams')
  const entries = list(field(streams, 'rungs'), 'streams.rungs', MAX_RUNGS)
  const readers = new Map<string, StreamRungKindParser>([['direct', DIRECT_READER]])
  for (const reader of options.kinds ?? []) readers.set(reader.kind, reader)
  const ids = new Set<string>()
  let fallbacks = 0
  const rungs: StreamRungConfig[] = []
  for (const [index, entry] of entries.entries()) {
    const path = `streams.rungs[${index}]`
    const object = record(entry, path)
    const id = text(field(object, 'id'), `${path}.id`, RUNG_ID)
    if (ids.has(id)) invalid(`${path}.id`, `repeats ${id}`)
    ids.add(id)
    const kind = text(field(object, 'kind'), `${path}.kind`, KIND_NAME)
    const fallback = flag(field(object, 'fallback'), `${path}.fallback`)
    fallbacks += Number(fallback)
    if (fallbacks > 1) invalid(`${path}.fallback`, 'marks a second last-resort rung')
    const reader = readers.get(kind)
    const parsed =
      reader === undefined ? undefined : rung(object, path, { id, kind, fallback }, reader)
    if (parsed !== undefined) rungs.push(parsed)
  }
  if (rungs.length === 0) invalid('streams.rungs', 'has no rung this build can run')
  return deepFreeze({
    revision,
    rungs,
    muxedAudioKbps: muxedAudioKbps(field(streams, 'muxedAudioKbps'), 'streams.muxedAudioKbps'),
  })
}

/** The stream config this build ships with, from `youtube-config.json`. */
export const BUNDLED_STREAM_CONFIG: StreamConfig = parseStreamConfig(bundledConfig)

/** Both parts of one YouTube config document. */
export interface YouTubeConfigs {
  /** The metadata config, for `createYouTubeSession` (see `parseYouTubeConfig`). */
  readonly metadata: YouTubeConfig
  /** The stream config, for `createYouTubeAudioSource` (see {@link parseStreamConfig}). */
  readonly streams: StreamConfig
}

/** Both parts of the config this build ships with. */
export const BUNDLED_YOUTUBE_CONFIGS: YouTubeConfigs = Object.freeze({
  metadata: BUNDLED_YOUTUBE_CONFIG,
  streams: BUNDLED_STREAM_CONFIG,
})

/** What {@link pickYouTubeConfigs} decided. */
export interface YouTubeConfigsChoice {
  /** The configs to use. */
  configs: YouTubeConfigs
  /** Whether they are the candidate's. */
  accepted: boolean
  /** Why the candidate was not taken, when it was not. */
  reason?: string
}

/**
 * Chooses between the configs in use and a candidate document that is already trusted (bundled,
 * or verified by `@fxm/platform`'s updater), for both parts at once, so that they never come from
 * different documents: the candidate wins only when its metadata part (`parseYouTubeConfig`) and
 * its `streams` part are both valid and its `revision` is higher than the current one. It never
 * throws, so a broken or older document leaves the current configs in place, and `reason` says
 * why. Create a new session with the new metadata config, and hand the stream config to the audio
 * source (its `streamConfig` can be a function that returns the one in use). It checks no
 * signature: never pass it a document straight from the network.
 */
export function pickYouTubeConfigs(
  candidate: unknown,
  current: YouTubeConfigs = BUNDLED_YOUTUBE_CONFIGS,
  options: StreamConfigOptions = {},
): YouTubeConfigsChoice {
  let configs: YouTubeConfigs
  try {
    configs = {
      metadata: parseYouTubeConfig(candidate),
      streams: parseStreamConfig(candidate, options),
    }
  } catch (error) {
    return { configs: current, accepted: false, reason: (error as Error).message }
  }
  const revision = Math.max(current.metadata.revision, current.streams.revision)
  if (configs.metadata.revision <= revision) {
    return {
      configs: current,
      accepted: false,
      reason: `revision ${configs.metadata.revision} is not newer than ${revision}`,
    }
  }
  return { configs, accepted: true }
}
