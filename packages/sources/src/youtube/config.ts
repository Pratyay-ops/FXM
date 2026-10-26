/**
 * The YouTube client config: client names and versions, the hosts each client calls, search
 * filter parameters, the radio parameters, kill switches and display labels by language. It is
 * data only, so a YouTube change that needs new values ships as a new `youtube-config.json` (a
 * static redeploy, or a signed config fetched from the static site) instead of new code.
 *
 * Every config goes through {@link parseYouTubeConfig}, which checks the schema and that every
 * host is one of the {@link INNERTUBE_HOSTS}: a config can change values, but never send a
 * request to another host. A config from the network must have its signature checked first:
 * the apps take one only through `youtube/module`'s host (`updates.config`) and
 * `@fxm/platform`'s updater.
 *
 * The same document carries the stream ladder's `streams` section, which stage 1.4 reads with
 * its own parser; this one ignores it.
 *
 * @module
 */

import { type AlbumType, FxmError } from '@fxm/core'
import bundledConfig from './youtube-config.json'

/**
 * The hosts InnerTube answers on. Every YouTube request FXM makes goes to one of them, whatever
 * the config says; the list lives in code so that no config can extend it.
 */
export const INNERTUBE_HOSTS = [
  'www.youtube.com',
  'music.youtube.com',
  'youtubei.googleapis.com',
] as const

/** One of the {@link INNERTUBE_HOSTS}. */
export type InnerTubeHost = (typeof INNERTUBE_HOSTS)[number]

/** The config format this build reads. A config with another `schema` is refused. */
export const YOUTUBE_CONFIG_SCHEMA = 1

/** An InnerTube client as FXM presents itself: its name, version and host. */
export interface YouTubeClientConfig {
  /** `context.client.clientName`, e.g. `WEB_REMIX`. */
  readonly name: string
  /** `context.client.clientVersion`, e.g. `1.20261020.10.00`. */
  readonly version: string
  /** The host the client's requests go to. */
  readonly host: InnerTubeHost
}

/** The YouTube Music search filters FXM uses, one per result type. */
export type MusicSearchFilter = 'songs' | 'videos' | 'albums' | 'artists' | 'playlists'

/** The plain YouTube search filters FXM uses. */
export type WebSearchFilter = 'videos' | 'channels' | 'playlists'

/**
 * Words YouTube shows in one language. They help to read text that no link or page type
 * describes; an unknown word only leaves a field out.
 */
export interface YouTubeLabels {
  /** An album's release type by its label in lower case, e.g. `single` → `single`. */
  readonly albumTypes: Readonly<Record<string, AlbumType>>
  /** Item type labels in bylines, in lower case, e.g. `song`: never an artist's name. */
  readonly itemTypes: readonly string[]
  /** The words after a track count, in lower case, e.g. `songs` in `12 songs`. */
  readonly trackCounts: readonly string[]
}

/** Switches that turn experimental paths off without a release. */
export interface YouTubeKillSwitches {
  /**
   * Turns the experimental Lite tier off everywhere: InnerTube then needs FXM Connect on the
   * web. `@fxm/platform` reads it (`createPlatform({ killSwitches })`).
   */
  readonly lite: boolean
}

/** A validated, frozen YouTube config. */
export interface YouTubeConfig {
  /** The config format, always {@link YOUTUBE_CONFIG_SCHEMA}. */
  readonly schema: typeof YOUTUBE_CONFIG_SCHEMA
  /** Increases with every published config; a config only replaces an older revision. */
  readonly revision: number
  /** When the config was last changed, as an ISO 8601 date, for people. */
  readonly updated?: string
  /** Where the full tier reads a server-issued visitorData. */
  readonly visitorData: {
    /** `https://www.youtube.com/sw.js_data`. */
    readonly swJsDataUrl: string
  }
  /** The clients FXM uses for metadata. */
  readonly clients: {
    /** YouTube Music (`WEB_REMIX`): search, browse, `next` and suggestions. */
    readonly music: YouTubeClientConfig
    /** Plain YouTube (`WEB`): video, channel and playlist search, and video descriptions. */
    readonly web: YouTubeClientConfig
  }
  /** The host for requests of clients the config does not list, such as the stream clients. */
  readonly defaultHost: InnerTubeHost
  /** The `params` of each search filter. */
  readonly search: {
    /** YouTube Music. */
    readonly music: Readonly<Record<MusicSearchFilter, string>>
    /** Plain YouTube. */
    readonly web: Readonly<Record<WebSearchFilter, string>>
  }
  /** Radio requests. */
  readonly radio: {
    /** The `params` YouTube Music sends with a radio (`next` with `RDAMVM<videoId>`). */
    readonly params: string
  }
  /** Kill switches; all off when the document has none. */
  readonly killSwitches: YouTubeKillSwitches
  /**
   * The labels of each language YouTube may answer in, by language tag (`en`, `pt-BR`); pick
   * them with {@link labelsFor}. `en` is required.
   */
  readonly labels: Readonly<Record<string, YouTubeLabels>>
}

const ALBUM_TYPES: readonly AlbumType[] = ['album', 'single', 'ep', 'compilation']
const MUSIC_FILTERS: readonly MusicSearchFilter[] = [
  'songs',
  'videos',
  'albums',
  'artists',
  'playlists',
]
const WEB_FILTERS: readonly WebSearchFilter[] = ['videos', 'channels', 'playlists']
const KILL_SWITCHES: readonly (keyof YouTubeKillSwitches)[] = ['lite']
const CLIENT_NAME = /^[A-Z][A-Z0-9_]{1,40}$/u
const CLIENT_VERSION = /^\d{1,4}(?:\.\d{1,10}){1,4}$/u
const PARAMS = /^[A-Za-z0-9_%=+/-]{2,200}$/u
const DATE = /^\d{4}-\d{2}-\d{2}$/u
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u
const MAX_LABELS = 100
const MAX_LANGUAGES = 100

/** The language whose labels stand in for a language the config has none for. */
const FALLBACK_LANGUAGE = 'en'

function invalid(path: string, problem: string): never {
  throw new FxmError('Parse', `Invalid YouTube config: ${path} ${problem}`)
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

function text(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(path, `must match ${pattern}`)
  return value
}

function host(value: unknown, path: string): InnerTubeHost {
  if (!(INNERTUBE_HOSTS as readonly unknown[]).includes(value)) {
    invalid(path, `must be one of ${INNERTUBE_HOSTS.join(', ')}`)
  }
  return value as InnerTubeHost
}

function httpsUrl(value: unknown, path: string): string {
  if (typeof value !== 'string' || !URL.canParse(value)) invalid(path, 'must be a URL')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    invalid(path, 'must be a plain https URL')
  }
  host(url.hostname, `${path} (host)`)
  return url.href
}

function client(value: unknown, path: string): YouTubeClientConfig {
  const object = record(value, path)
  return {
    name: text(field(object, 'name'), `${path}.name`, CLIENT_NAME),
    version: text(field(object, 'version'), `${path}.version`, CLIENT_VERSION),
    host: host(field(object, 'host'), `${path}.host`),
  }
}

function params<K extends string>(value: unknown, path: string, keys: readonly K[]) {
  const object = record(value, path)
  return Object.fromEntries(
    keys.map((key) => [key, text(field(object, key), `${path}.${key}`, PARAMS)]),
  ) as Record<K, string>
}

function words(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LABELS) {
    invalid(path, `must be a list of at most ${MAX_LABELS} words`)
  }
  return value.map((word, index) => {
    if (typeof word !== 'string' || word.trim() === '' || word.length > 40) {
      invalid(`${path}[${index}]`, 'must be a word')
    }
    return word.trim().toLowerCase()
  })
}

function albumTypes(value: unknown, path: string): Record<string, AlbumType> {
  const entries = Object.entries(record(value, path))
  if (entries.length > MAX_LABELS) invalid(path, `must have at most ${MAX_LABELS} labels`)
  return Object.fromEntries(
    entries.map(([label, type]) => {
      if (label.trim() === '' || label.length > 40) invalid(`${path}.${label}`, 'needs a label')
      if (!(ALBUM_TYPES as readonly unknown[]).includes(type)) {
        invalid(`${path}.${label}`, `must be one of ${ALBUM_TYPES.join(', ')}`)
      }
      return [label.trim().toLowerCase(), type as AlbumType]
    }),
  )
}

function languageLabels(value: unknown, path: string): YouTubeLabels {
  const object = record(value, path)
  return {
    albumTypes: albumTypes(field(object, 'albumTypes'), `${path}.albumTypes`),
    itemTypes: words(field(object, 'itemTypes'), `${path}.itemTypes`),
    trackCounts: words(field(object, 'trackCounts'), `${path}.trackCounts`),
  }
}

function labels(value: unknown, path: string): Record<string, YouTubeLabels> {
  const entries = Object.entries(record(value, path))
  if (entries.length > MAX_LANGUAGES) invalid(path, `must have at most ${MAX_LANGUAGES} languages`)
  const byLanguage = Object.fromEntries(
    entries.map(([language, entry]) => {
      if (!LANGUAGE.test(language)) invalid(`${path}.${language}`, 'needs a language tag as key')
      return [language, languageLabels(entry, `${path}.${language}`)]
    }),
  )
  if (!Object.hasOwn(byLanguage, FALLBACK_LANGUAGE)) {
    invalid(`${path}.${FALLBACK_LANGUAGE}`, 'is required')
  }
  return byLanguage
}

function killSwitches(value: unknown, path: string): YouTubeKillSwitches {
  const object = value === undefined ? {} : record(value, path)
  const switches = { lite: false }
  for (const name of KILL_SWITCHES) {
    const flag = field(object, name)
    if (flag !== undefined && typeof flag !== 'boolean')
      invalid(`${path}.${name}`, 'must be a boolean')
    if (flag === true) switches[name] = true
  }
  return switches
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Checks a config, e.g. one parsed from `youtube-config.json` or fetched from the static site,
 * and returns it typed and frozen. Unknown fields are ignored, so a newer config of the same
 * schema still loads.
 *
 * @throws FxmError `Parse` naming the first field that is missing or wrong, including a host that
 * is not one of the {@link INNERTUBE_HOSTS}.
 */
export function parseYouTubeConfig(input: unknown): YouTubeConfig {
  const root = record(input, 'config')
  if (field(root, 'schema') !== YOUTUBE_CONFIG_SCHEMA) {
    invalid('schema', `must be ${YOUTUBE_CONFIG_SCHEMA}`)
  }
  const revision = field(root, 'revision')
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    invalid('revision', 'must be a positive integer')
  }
  const updated = field(root, 'updated')
  const clients = record(field(root, 'clients'), 'clients')
  const search = record(field(root, 'search'), 'search')
  const config: YouTubeConfig = {
    schema: YOUTUBE_CONFIG_SCHEMA,
    revision,
    ...(updated === undefined ? {} : { updated: text(updated, 'updated', DATE) }),
    visitorData: {
      swJsDataUrl: httpsUrl(
        field(record(field(root, 'visitorData'), 'visitorData'), 'swJsDataUrl'),
        'visitorData.swJsDataUrl',
      ),
    },
    clients: {
      music: client(field(clients, 'music'), 'clients.music'),
      web: client(field(clients, 'web'), 'clients.web'),
    },
    defaultHost: host(field(root, 'defaultHost'), 'defaultHost'),
    search: {
      music: params(field(search, 'music'), 'search.music', MUSIC_FILTERS),
      web: params(field(search, 'web'), 'search.web', WEB_FILTERS),
    },
    radio: {
      params: text(field(record(field(root, 'radio'), 'radio'), 'params'), 'radio.params', PARAMS),
    },
    killSwitches: killSwitches(field(root, 'killSwitches'), 'killSwitches'),
    labels: labels(field(root, 'labels'), 'labels'),
  }
  return deepFreeze(config)
}

/**
 * The labels to read YouTube's text in the language `hl` with: the config's for `hl` itself
 * (`pt-BR`), else for its language (`pt`), else its English ones, whose words many languages
 * share (`Single`, `EP`, `Video`).
 */
export function labelsFor(config: YouTubeConfig, hl: string): YouTubeLabels {
  const language = hl.split('-')[0] ?? hl
  for (const key of [hl, language]) {
    const labels = Object.hasOwn(config.labels, key) ? config.labels[key] : undefined
    if (labels !== undefined) return labels
  }
  return config.labels[FALLBACK_LANGUAGE] as YouTubeLabels
}

/** The config this build ships with, from `youtube-config.json`. */
export const BUNDLED_YOUTUBE_CONFIG: YouTubeConfig = parseYouTubeConfig(bundledConfig)

/** What {@link pickYouTubeConfig} decided. */
export interface ConfigChoice {
  /** The config to use. */
  config: YouTubeConfig
  /** Whether it is the candidate. */
  accepted: boolean
  /** Why the candidate was not taken, when it was not. */
  reason?: string
}

/**
 * Chooses between the config in use and a candidate that is already trusted (bundled, or
 * verified by `@fxm/platform`'s updater): the candidate wins only when it is valid and has a
 * higher `revision`. It never throws, so a broken or older config leaves the current one in
 * place, and `reason` says why. It checks no signature: never pass it a config straight from the
 * network; the apps take those through `youtube/module`'s host.
 */
export function pickYouTubeConfig(
  candidate: unknown,
  current: YouTubeConfig = BUNDLED_YOUTUBE_CONFIG,
): ConfigChoice {
  let parsed: YouTubeConfig
  try {
    parsed = parseYouTubeConfig(candidate)
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
