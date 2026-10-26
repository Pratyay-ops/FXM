/**
 * The inputs of the labelled set, built from public data: tracks of public Spotify playlists
 * (charts, decades, genres) and searches through the Spotify provider of stage 1.5, their ISRC,
 * label, release date, album type and popularity from `metadata/4`, and what MusicBrainz's exact
 * and fuzzy paths (stage 1.6) find for them. Each track becomes a group with one input per slice
 * (see `matchingEval.EvalSlice`):
 *
 * - `spotify`: Spotify's metadata as the matcher gets it in the app;
 * - `data-export`: the row Spotify's "Download your data" export would have (the title, the
 *   main artist only, the album and the URI; no duration, no ISRC), filled in by the MusicBrainz
 *   exact path as imports do;
 * - `musicbrainz-exact`: the recording MusicBrainz links to the track, with its own title,
 *   credits, length and ISRCs: an input that does not use Spotify's metadata;
 * - `musicbrainz-fuzzy`: the track's names and length with the ISRC of a MusicBrainz recording
 *   search, a hint only.
 *
 * Building is resumable like the recording: the tracks each source gave are kept in the
 * checkpoint, a group is written as soon as its Spotify facts are in, and each group's
 * provenance names the source that created it, so a source counts only its own groups.
 *
 * @module
 */

import {
  type ArtistRef,
  formatId,
  isFxmError,
  type MatchSource,
  matchingEval,
  type ProviderContext,
  type Track,
} from '@fxm/core'
import type {
  findExactIsrcs as FindExactIsrcs,
  findIsrcHint as FindIsrcHint,
  IsrcFinding,
} from '../musicbrainz'
import type { SpotifyProvider, SpotifyTrackDetails } from '../spotify'
import { csvGroup, parseExportifyCsv } from './csv'
import type { EvalCheckpoint, EvalStore, PoolTrack } from './store'

type EvalCategory = matchingEval.EvalCategory
type EvalGroup = matchingEval.EvalGroup
type EvalVariant = matchingEval.EvalVariant
type EvalMusicBrainzExact = matchingEval.EvalMusicBrainzExact

/** Where a share of the inputs comes from. */
export interface InputSource {
  /** A stable key, e.g. `playlist:37i9dQZEVXbMDoHDwVN2tF` or `search:Spotify Singles`. */
  key: string
  /** A Spotify playlist or a Spotify track search. */
  kind: 'playlist' | 'search'
  /** The playlist's base62 ID, or the search's query. */
  ref: string
  /** For people (provenance). */
  name: string
  /** How many tracks to take, in the source's order, after filtering and de-duplicating. */
  take: number
  /** The categories the source stands for (only some are taken as they are, see `categoriesOfInput`). */
  categories?: EvalCategory[]
  /** Keeps only tracks that look like the category, e.g. for a search's loose hits. */
  filter?: 'spotify-singles' | 're-recording' | 'compilation' | 'classical'
}

function playlist(
  ref: string,
  name: string,
  take: number,
  categories: EvalCategory[] = [],
): InputSource {
  return { key: `playlist:${ref}`, kind: 'playlist', ref, name, take, categories }
}

function search(
  query: string,
  take: number,
  filter: InputSource['filter'],
  categories: EvalCategory[] = [],
): InputSource {
  return {
    key: `search:${query}`,
    kind: 'search',
    ref: query,
    name: `Spotify search "${query}"`,
    take,
    categories,
    ...(filter === undefined ? {} : { filter }),
  }
}

/**
 * The input plans. `proof` is the recorder's small proof run (8 tracks); `full` is the set the
 * report's gate needs: about 370 distinct tracks (each source takes tracks no earlier source
 * took), so that the held-out split (70 %) holds about 260, well above the gate's 200 even when
 * a source cannot be read or some groups fail to record. Chart and editorial playlists change
 * daily; the inputs keep what they held when they were read, with the date in their provenance.
 */
export const INPUT_PLANS: Readonly<Record<'proof' | 'full', readonly InputSource[]>> = {
  proof: [
    playlist('37i9dQZEVXbMDoHDwVN2tF', 'Top 50 - Global', 3),
    playlist('37i9dQZEVXbKXQ4mDTEBXq', 'Top 50 - Japan', 1, ['regional']),
    playlist('37i9dQZEVXbLZ52XmnySJg', 'Top 50 - India', 1, ['regional']),
    playlist('37i9dQZF1DWWEJlAGA9gs0', 'Classical Essentials', 1, ['classical']),
    search('Spotify Singles', 1, 'spotify-singles'),
    search("Taylor's Version", 1, 're-recording'),
  ],
  full: [
    // Mainstream: global charts and decades.
    playlist('37i9dQZEVXbMDoHDwVN2tF', 'Top 50 - Global', 45),
    playlist('37i9dQZF1DXcBWIGoYBM5M', "Today's Top Hits", 25),
    playlist('37i9dQZEVXbLRQDuF5jeBp', 'Top 50 - USA', 15),
    playlist('37i9dQZEVXbLnolsZ8PSNw', 'Top 50 - UK', 10),
    playlist('37i9dQZF1DXaKIA8E7WcJj', 'All Out 60s', 8),
    playlist('37i9dQZF1DWTJ7xPn4vNaz', 'All Out 70s', 9),
    playlist('37i9dQZF1DX4UtSsGT1Sbe', 'All Out 80s', 11),
    playlist('37i9dQZF1DXbTxeAdrVG2l', 'All Out 90s', 11),
    playlist('37i9dQZF1DX4o1oenSJRJd', 'All Out 2000s', 11),
    playlist('37i9dQZF1DX5Ejj0EkURtP', 'All Out 2010s', 11),
    playlist('37i9dQZF1DWXRqgorJj26U', 'Rock Classics', 12),
    // Regional, several scripts.
    playlist('37i9dQZEVXbLZ52XmnySJg', 'Top 50 - India', 18, ['regional']),
    playlist('37i9dQZEVXbKXQ4mDTEBXq', 'Top 50 - Japan', 12, ['regional']),
    playlist('37i9dQZEVXbNxXF4SkHj9F', 'Top 50 - South Korea', 12, ['regional']),
    playlist('37i9dQZEVXbMXbN3EUUhlg', 'Top 50 - Brazil', 10, ['regional']),
    playlist('37i9dQZEVXbO3qyFxbkOE1', 'Top 50 - Mexico', 10, ['regional']),
    playlist('37i9dQZEVXbKY7jLzlJ11V', 'Top 50 - Nigeria', 8, ['regional']),
    playlist('37i9dQZEVXbLn7RQmT5Xv2', 'Top 50 - Egypt', 6, ['regional']),
    // Classical.
    playlist('37i9dQZF1DWWEJlAGA9gs0', 'Classical Essentials', 22, ['classical']),
    search('Symphony No. 5', 5, 'classical', ['classical']),
    // Long tail: emerging artists.
    playlist('37i9dQZF1DWWjGdmeTyeJ6', 'Fresh Finds', 28, ['long-tail']),
    // Spotify Singles: Spotify's own recordings.
    search('Spotify Singles', 18, 'spotify-singles'),
    search('Recorded at Spotify Studios', 5, 'spotify-singles'),
    // Re-recordings.
    search("Taylor's Version", 12, 're-recording'),
    search('Re-Recorded', 10, 're-recording'),
    search('Rerecorded', 5, 're-recording'),
    // Compilations.
    search("Now That's What I Call Music", 10, 'compilation'),
    search('Greatest Hits', 10, 'compilation'),
  ],
}

/**
 * The held-out groups an input plan should give at least before the recording starts: the
 * gate's 200 recorded groups, with room for groups that fail to record. The record command
 * refuses to start the full set below it (see `README.md`).
 */
export const MIN_PLANNED_HELD_OUT = 215

/** How many of these groups fall in each split (see `matchingEval.splitOf`). */
export function projectedSplits(ids: readonly string[]): { heldOut: number; calibration: number } {
  const calibration = ids.filter((id) => matchingEval.splitOf(id) === 'calibration').length
  return { heldOut: ids.length - calibration, calibration }
}

/** A group's provenance line for a track a source gave: `<name> #<position> (<key>), read <date>`. */
export function provenanceLine(source: InputSource, index: number, readOn: string): string {
  return `${source.name} #${index + 1} (${source.key}), read ${readOn}`
}

/** The key of the source a provenance line names (see {@link provenanceLine}), if any. */
export function sourceKeyOf(provenance: string): string | undefined {
  return /^.* #\d+ \(((?:playlist|search):.+)\), read \d{4}-\d{2}-\d{2}$/u.exec(provenance)?.[1]
}

/**
 * Inputs written down from earlier research, which no public playlist yields: the two known ISRC
 * squatters (another catalogue maps the ISRC to these tracks; YouTube Music returns another
 * recording for it). Facts from the research of 2026-10-25, as in the matching golden set.
 */
export const FIXED_INPUTS: ReadonlyArray<{ id: string; source: MatchSource; provenance: string }> =
  [
    {
      id: 'fx:squatter-gbaye0601696',
      source: {
        title: 'Live-LongLive-Strong',
        artists: [{ name: 'Waw*Mart' }],
        album: { name: 'Wally World' },
        durationMs: 193000,
        isrc: 'GBAYE0601696',
        isrcOrigin: 'catalog',
      },
      provenance:
        'research 2026-10-25: Deezer maps GBAYE0601696 to this track; YouTube Music returns the Beatles (matching golden set, squatter/GBAYE0601696)',
    },
    {
      id: 'fx:squatter-qmfmf2447070',
      source: {
        title: 'You and me',
        artists: [{ name: 'Lil dexxy' }],
        album: { name: 'I’m so messy' },
        durationMs: 90000,
        isrc: 'QMFMF2447070',
        isrcOrigin: 'catalog',
      },
      provenance:
        'research 2026-10-25: Deezer maps QMFMF2447070 to this track; YouTube Music returns "DtMF" (matching golden set, squatter/QMFMF2447070)',
    },
  ]

/** A Spotify track as a pool entry. */
export function poolTrackOf(track: Track): PoolTrack | undefined {
  const id = track.id.startsWith('spotify:track:') ? track.id.slice('spotify:track:'.length) : ''
  if (id === '') return undefined
  const entry: PoolTrack = {
    id,
    title: track.title,
    artists: track.artists.map((artist) => artist.name),
  }
  if (track.album !== undefined) entry.album = track.album.name
  if (track.durationMs !== undefined) entry.durationMs = track.durationMs
  if (track.explicit !== undefined) entry.explicit = track.explicit
  if (track.releaseDate !== undefined) entry.releaseDate = track.releaseDate
  return entry
}

const SPOTIFY_SINGLES = /\bspotify singles?\b|recorded at spotify studios|\bspotify sessions?\b/iu
const RE_RECORDING =
  /taylor['’]s version|re-?recorded|\bre-?record(?:ing)?\b|\(\d{4} version\)|\bforgery\b|\bnew recording\b/iu
const COMPILATION =
  /now that'?s what i call|greatest hits|best of|\bhits\b|collection|essentials|anthology|\bclassics\b/iu

/** Whether a pool track passes a source's filter. */
export function passesFilter(track: PoolTrack, filter: InputSource['filter']): boolean {
  const text = `${track.title} ${track.album ?? ''}`
  switch (filter) {
    case undefined:
      return true
    case 'spotify-singles':
      return SPOTIFY_SINGLES.test(text)
    case 're-recording':
      return RE_RECORDING.test(text)
    case 'compilation':
      return COMPILATION.test(track.album ?? '')
    case 'classical':
      return matchingEval
        .categoriesOfInput({ title: track.title, artists: track.artists })
        .includes('classical')
  }
}

/** `T` with every field optional and possibly `undefined`, as {@link defined} takes it. */
type Loose<T> = { [K in keyof T]?: T[K] | undefined }

/** Optional fields, left out when unknown. */
function defined<T extends object>(value: Loose<T>): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

function artistRefs(names: readonly string[]): ArtistRef[] {
  return names.map((name) => ({ name }))
}

/** The `spotify` input: the track's metadata with `metadata/4`'s facts. */
export function spotifyInput(track: PoolTrack, details: SpotifyTrackDetails): MatchSource {
  return defined<MatchSource>({
    title: track.title,
    artists: artistRefs(track.artists),
    album: track.album === undefined ? undefined : { name: track.album },
    durationMs: track.durationMs,
    isrc: details.isrc,
    isrcOrigin: details.isrc === undefined ? undefined : 'catalog',
    explicit: track.explicit,
    releaseDate: details.releaseDate ?? track.releaseDate,
    label: details.label,
    albumType: details.albumType,
  })
}

/** The ISRC and its origin from a MusicBrainz recording's ISRCs. */
function exactIsrc(exact: EvalMusicBrainzExact): Pick<MatchSource, 'isrc' | 'isrcOrigin'> {
  const [first, ...others] = exact.isrcs
  if (first === undefined) return {}
  return {
    isrc: first,
    isrcOrigin: others.length === 0 ? 'musicbrainz-exact' : 'musicbrainz-exact-several',
  }
}

/**
 * Every input of a track, from its primary input (`spotify` or `csv`): the primary, then
 * `data-export` (always: the title, the main artist and the album, as a row of the export names
 * them, filled in by MusicBrainz's exact path), `musicbrainz-exact` (when the exact path linked a
 * recording) and `musicbrainz-fuzzy` (when the fuzzy path found an ISRC: the primary's names,
 * duration and explicit mark with that ISRC as a hint, the evaluation's case of full metadata
 * without a trusted ISRC).
 */
export function buildVariants(
  primary: EvalVariant,
  exact: EvalMusicBrainzExact | null | undefined,
  fuzzyIsrc: string | undefined,
): EvalVariant[] {
  const { source } = primary
  const variants: EvalVariant[] = [primary]
  const album = source.album === undefined ? undefined : { name: source.album.name }
  const names = defined<MatchSource>({
    title: source.title,
    artists: source.artists.map((artist) => ({ name: artist.name })),
    album,
  })
  // A row of the export names one artist ("Name of the artist, band or podcast", in Spotify's
  // description of the export; see the Spotify clean-room log).
  const row = defined<MatchSource>({
    title: source.title,
    artists: source.artists.slice(0, 1).map((artist) => ({ name: artist.name })),
    album,
  })
  const filled =
    exact === null || exact === undefined
      ? {}
      : defined<MatchSource>({ ...exactIsrc(exact), durationMs: exact.lengthMs })
  variants.push({ slice: 'data-export', source: { ...row, ...filled } })
  if (exact !== null && exact !== undefined) {
    variants.push({
      slice: 'musicbrainz-exact',
      source: defined<MatchSource>({
        title: exact.title,
        artists: artistRefs(exact.artists),
        durationMs: exact.lengthMs,
        ...exactIsrc(exact),
        releaseDate: exact.firstReleaseDate,
      }),
    })
  }
  if (fuzzyIsrc !== undefined) {
    variants.push({
      slice: 'musicbrainz-fuzzy',
      source: defined<MatchSource>({
        ...names,
        durationMs: source.durationMs,
        explicit: source.explicit,
        isrc: fuzzyIsrc,
        isrcOrigin: 'musicbrainz-fuzzy',
      }),
    })
  }
  return variants
}

/** What MusicBrainz's exact path found, as the labelled set keeps it. */
export function exactOf(finding: IsrcFinding | undefined): EvalMusicBrainzExact | null {
  if (finding === undefined) return null
  const { recording } = finding
  return defined<EvalMusicBrainzExact>({
    recording: recording.id,
    title: recording.title,
    artists: recording.artists,
    lengthMs: recording.lengthMs,
    isrcs: finding.isrcs,
    firstReleaseDate: recording.firstReleaseDate,
  })
}

/** The services the inputs come from. */
export interface InputProviders {
  /** Spotify (stage 1.5). */
  readonly spotify: Pick<
    SpotifyProvider,
    'getPlaylist' | 'getPlaylistTracks' | 'search' | 'getTrackDetails'
  >
  /** MusicBrainz's exact path for many tracks (stage 1.6, `findExactIsrcs` bound to a client). */
  readonly findExactIsrcs: (
    references: readonly string[],
    ctx: ProviderContext,
  ) => ReturnType<typeof FindExactIsrcs>
  /** MusicBrainz's fuzzy path (stage 1.6, `findIsrcHint` bound to a client). */
  readonly findIsrcHint: (
    track: Parameters<typeof FindIsrcHint>[1],
    ctx: ProviderContext,
  ) => ReturnType<typeof FindIsrcHint>
}

/** Options for {@link buildInputs}. */
export interface InputOptions {
  /** The services. */
  providers: InputProviders
  /** The context for Spotify (a native platform, so the browser User-Agent goes along). */
  spotifyCtx: ProviderContext
  /** The context for MusicBrainz. */
  musicBrainzCtx: ProviderContext
  /** Where the groups and the checkpoint live. */
  store: EvalStore
  /** The checkpoint to update; read from the store when absent. */
  checkpoint?: EvalCheckpoint
  /** Which plan. */
  plan: keyof typeof INPUT_PLANS
  /** Whether to add the fixed inputs. Default: with the full plan only. */
  fixed?: boolean
  /** Builds at most this many new groups in this run. */
  limit?: number
  /** The date the sources are read, for provenance (`YYYY-MM-DD`). */
  today: string
  /**
   * The text of the owner's Exportify-style CSV, whose rows become `csv` groups. They are
   * published with the labelled set (see `README.md`).
   */
  csv?: string
  /** Progress, one line at a time. */
  log?: (line: string) => void
}

/** What an inputs run did. */
export interface InputSummary {
  /** Groups written in this run. */
  created: string[]
  /** Groups whose MusicBrainz facts or inputs were completed or rebuilt in this run. */
  completed: string[]
  /** Sources or tracks that failed, with why. */
  failed: Record<string, string>
  /** Sources that gave fewer tracks than they should, with how many they gave. */
  short: Record<string, number>
  /** Why the run stopped reading Spotify or MusicBrainz early, if it did; the next run resumes. */
  stopped?: string
  /** The groups in the store by split after this run, for the gate's 200 held-out groups. */
  heldOut: number
  calibration: number
}

/** Failures in a row after which a service is left alone for this run. */
const MAX_FAILURES_IN_ROW = 3

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** Reads a source's tracks: the first 50 of a playlist, and more pages while needed; a search's first 50. */
async function readPool(
  source: InputSource,
  providers: InputProviders,
  ctx: ProviderContext,
): Promise<PoolTrack[]> {
  const tracks: Track[] = []
  if (source.kind === 'playlist') {
    const id = formatId('spotify', 'playlist', source.ref)
    const first = await providers.spotify.getPlaylist(id, ctx)
    tracks.push(...(first.tracks?.items ?? []))
    let cursor = first.tracks?.nextCursor
    while (cursor !== undefined && tracks.length < source.take * 3 && tracks.length < 200) {
      const page = await providers.spotify.getPlaylistTracks(id, { cursor, limit: 100 }, ctx)
      tracks.push(...page.items)
      cursor = page.nextCursor
    }
  } else {
    const results = await providers.spotify.search(source.ref, { types: ['track'], limit: 50 }, ctx)
    tracks.push(...(results.tracks?.items ?? []))
  }
  return tracks.map(poolTrackOf).filter((track): track is PoolTrack => track !== undefined)
}

/**
 * Builds the inputs of a plan, resumably: reads each source once (kept in the checkpoint),
 * creates a group per new track with its Spotify facts, then completes every group's
 * MusicBrainz facts and inputs.
 *
 * A track two sources give is one group, created by the first; each source counts only the
 * groups it created (its provenance names it), so its `take` is met with distinct tracks, in
 * this run or across runs. A track Spotify does not know (`NotFound`) is skipped for good; any
 * other failure only for this run. Spotify's or MusicBrainz's rate limit, or three failures in
 * a row, stop that service for this run, and the next run goes on from there.
 */
export async function buildInputs(options: InputOptions): Promise<InputSummary> {
  const { providers, spotifyCtx, store, plan, limit, today } = options
  const log = options.log ?? (() => {})
  const checkpoint = options.checkpoint ?? (await store.readCheckpoint())
  checkpoint.inputs.plan = plan
  const summary: InputSummary = {
    created: [],
    completed: [],
    failed: {},
    short: {},
    heldOut: 0,
    calibration: 0,
  }
  /** Every group in the store, with the key of the source that created it. */
  const existing = new Map<string, string | undefined>()
  for (const id of await store.listGroups()) {
    const group = await store.readGroup(id)
    existing.set(id, sourceKeyOf(group?.provenance[0] ?? ''))
  }
  const sources = INPUT_PLANS[plan]
  const save = () => store.writeCheckpoint(checkpoint)
  const stop = (why: string) => {
    summary.stopped = why
    log(`stopped: ${why}`)
  }

  const withFixed = options.fixed ?? plan === 'full'
  if (withFixed) {
    for (const fixed of FIXED_INPUTS) {
      if (existing.has(fixed.id)) continue
      const group: EvalGroup = {
        id: fixed.id,
        split: matchingEval.splitOf(fixed.id),
        categories: ['isrc-squatter'],
        provenance: [fixed.provenance],
        variants: [{ slice: 'fixed', source: fixed.source }],
      }
      await store.writeGroup(group)
      existing.set(fixed.id, undefined)
      summary.created.push(fixed.id)
    }
  }

  // 1. Read the sources and create the groups, with Spotify's facts.
  let spotifyFailures = 0
  /** Counts a passing Spotify failure; false once the run should leave Spotify alone. */
  const spotifyFailed = (error: unknown): boolean => {
    if (isFxmError(error, 'RateLimited')) {
      stop(`Spotify rate-limited the run (${messageOf(error)}); run it again later`)
      return false
    }
    spotifyFailures += 1
    if (spotifyFailures >= MAX_FAILURES_IN_ROW) {
      stop(`${spotifyFailures} Spotify requests in a row failed (${messageOf(error)})`)
      return false
    }
    return true
  }
  for (const source of sources) {
    if (summary.stopped !== undefined) break
    if (limit !== undefined && summary.created.length >= limit) break
    let pool = checkpoint.inputs.pools[source.key]
    if (pool === undefined) {
      try {
        pool = await readPool(source, providers, spotifyCtx)
        spotifyFailures = 0
      } catch (error) {
        summary.failed[source.key] = messageOf(error)
        log(`could not read ${source.name}: ${messageOf(error)}`)
        if (!spotifyFailed(error)) break
        continue
      }
      checkpoint.inputs.pools[source.key] = pool
      checkpoint.inputs.readAt[source.key] = today
      await save()
      log(`read ${source.name}: ${pool.length} tracks`)
    }
    const readOn = checkpoint.inputs.readAt[source.key] ?? today
    let taken = [...existing.values()].filter((key) => key === source.key).length
    let limited = false
    for (const [index, track] of pool.entries()) {
      if (taken >= source.take || summary.stopped !== undefined) break
      if (!passesFilter(track, source.filter)) continue
      const id = `sp:${track.id}`
      // Created by this source in an earlier run (counted above), or by another source.
      if (existing.has(id)) continue
      if (checkpoint.inputs.failed[id] !== undefined) continue
      if (limit !== undefined && summary.created.length >= limit) {
        limited = true
        break
      }
      let details: SpotifyTrackDetails
      try {
        details = await providers.spotify.getTrackDetails(
          formatId('spotify', 'track', track.id),
          spotifyCtx,
        )
        spotifyFailures = 0
      } catch (error) {
        summary.failed[id] = messageOf(error)
        if (isFxmError(error, 'NotFound')) {
          checkpoint.inputs.failed[id] = messageOf(error)
          await save()
          continue
        }
        if (!spotifyFailed(error)) break
        continue
      }
      const categories = matchingEval.categoriesOfInput({
        title: track.title,
        artists: track.artists,
        ...(track.album === undefined ? {} : { album: track.album }),
        ...(details.albumType === undefined ? {} : { albumType: details.albumType }),
        ...(details.popularity === undefined ? {} : { popularity: details.popularity }),
        sourceCategories: source.categories ?? [],
      })
      const group: EvalGroup = {
        id,
        split: matchingEval.splitOf(id),
        categories,
        provenance: [provenanceLine(source, index, readOn)],
        spotify: defined<NonNullable<EvalGroup['spotify']>>({
          id: track.id,
          popularity: details.popularity,
          albumType: details.albumType,
        }),
        variants: [{ slice: 'spotify', source: spotifyInput(track, details) }],
      }
      await store.writeGroup(group)
      existing.set(id, source.key)
      taken += 1
      summary.created.push(id)
      log(`created ${id}: ${track.title} - ${track.artists.join(', ')} [${categories.join(', ')}]`)
    }
    if (taken < source.take && summary.stopped === undefined && !limited) {
      summary.short[source.key] = taken
      log(`${source.name} gave ${taken} of ${source.take} tracks: no more of its tracks fit`)
    }
  }

  // The owner's CSV rows, as they are.
  if (options.csv !== undefined) {
    for (const row of parseExportifyCsv(options.csv)) {
      const group = csvGroup(row, today)
      if (existing.has(group.id)) continue
      await store.writeGroup(group)
      existing.set(group.id, undefined)
      summary.created.push(group.id)
    }
  }

  // 2. MusicBrainz: the exact path for every group without its answer (batched), then the
  // fuzzy path, and 3. the inputs, once both paths have answered.
  await completeGroups(options, summary, log, stop)
  await save()
  Object.assign(summary, projectedSplits(await store.listGroups()))
  return summary
}

/**
 * Steps 2 and 3 of {@link buildInputs}: MusicBrainz's answers, then every group's inputs, built
 * again from its primary input and those answers, so that a group gets the inputs of the rules
 * in `buildVariants` even when they changed after it was recorded (the recorder records what
 * they need then).
 */
async function completeGroups(
  options: InputOptions,
  summary: InputSummary,
  log: (line: string) => void,
  stop: (why: string) => void,
): Promise<void> {
  const { providers, musicBrainzCtx, store } = options
  const groups: EvalGroup[] = []
  for (const id of await store.listGroups()) {
    const group = await store.readGroup(id)
    if (group?.spotify !== undefined) groups.push(group)
  }
  const changed = new Set<EvalGroup>()
  const needExact = groups.filter((group) => group.musicBrainz?.exact === undefined)
  if (needExact.length > 0) {
    try {
      const references = needExact.map((group) => `spotify:track:${group.spotify?.id ?? ''}`)
      const findings = await providers.findExactIsrcs(references, musicBrainzCtx)
      for (const group of needExact) {
        const finding = findings.get(`spotify:track:${group.spotify?.id ?? ''}`)
        group.musicBrainz = { ...group.musicBrainz, exact: exactOf(finding) }
        changed.add(group)
      }
    } catch (error) {
      summary.failed['musicbrainz:exact'] = messageOf(error)
      log(`MusicBrainz's exact path failed: ${messageOf(error)}`)
    }
  }
  let failures = 0
  let fuzzyStopped = false
  for (const group of groups) {
    const primary = group.variants.find(
      (variant) => variant.slice === 'spotify' || variant.slice === 'csv',
    )
    if (primary === undefined) continue
    if (group.musicBrainz?.fuzzy === undefined && !fuzzyStopped) {
      try {
        const query = {
          title: primary.source.title,
          artists: primary.source.artists,
          ...(primary.source.durationMs === undefined
            ? {}
            : { durationMs: primary.source.durationMs }),
        }
        const hint = await providers.findIsrcHint(query, musicBrainzCtx)
        failures = 0
        group.musicBrainz = {
          ...group.musicBrainz,
          fuzzy: hint === null ? null : { recording: hint.recording.id, isrcs: hint.isrcs },
        }
        changed.add(group)
      } catch (error) {
        summary.failed[`${group.id}:fuzzy`] = messageOf(error)
        log(`MusicBrainz's fuzzy path failed for ${group.id}: ${messageOf(error)}`)
        failures += 1
        if (isFxmError(error, 'RateLimited') || failures >= MAX_FAILURES_IN_ROW) {
          stop(`MusicBrainz's fuzzy path failed ${failures} times in a row (${messageOf(error)})`)
          fuzzyStopped = true
        }
      }
    }
    const exact = group.musicBrainz?.exact
    const fuzzy = group.musicBrainz?.fuzzy
    if (exact !== undefined && fuzzy !== undefined) {
      const variants = buildVariants(primary, exact, fuzzy?.isrcs[0])
      if (JSON.stringify(variants) !== JSON.stringify(group.variants)) {
        group.variants = variants
        summary.completed.push(group.id)
        changed.add(group)
      }
    }
    if (changed.has(group)) await store.writeGroup(group)
  }
}
