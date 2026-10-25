import type { PlaylistSummary, TrackRow } from '../../db/repo'
import type { PlaylistSortKey, SortDirection, SortView, TrackSortKey } from './view-store'

/** The views of a track list, in menu order. */
export const TRACK_SORTS: readonly { key: TrackSortKey; label: string }[] = [
  { key: 'custom', label: 'Custom order' },
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'added', label: 'Date added' },
  { key: 'duration', label: 'Duration' },
]

/** The views of the list of playlists, in menu order. */
export const PLAYLIST_SORTS: readonly { key: PlaylistSortKey; label: string }[] = [
  { key: 'custom', label: 'Custom order' },
  { key: 'name', label: 'Name' },
  { key: 'added', label: 'Date added' },
  { key: 'tracks', label: 'Number of songs' },
]

/** How each direction of a sort reads: "A to Z", "Newest first"… */
export function directionLabel(key: string, direction: SortDirection): string {
  const [asc, desc] =
    key === 'added'
      ? ['Oldest first', 'Newest first']
      : key === 'duration'
        ? ['Shortest first', 'Longest first']
        : key === 'tracks'
          ? ['Fewest first', 'Most first']
          : ['A to Z', 'Z to A']
  return direction === 'asc' ? asc : desc
}

/** "Sorted by title, A to Z". */
export function describeSort(
  sorts: readonly { key: string; label: string }[],
  view: SortView<string>,
): string {
  const label = sorts.find((sort) => sort.key === view.key)?.label ?? view.key
  return `Sorted by ${label.toLowerCase()}, ${directionLabel(view.key, view.direction)}`
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** Compares texts, with missing ones last in either direction. */
function byText(a: string | undefined, b: string | undefined, sign: number): number {
  if (!a || !b) return (a ? 0 : 1) - (b ? 0 : 1)
  return sign * collator.compare(a, b)
}

/** Compares numbers, with missing ones last in either direction. */
function byNumber(a: number | undefined, b: number | undefined, sign: number): number {
  if (a === undefined || b === undefined)
    return (a === undefined ? 1 : 0) - (b === undefined ? 1 : 0)
  return sign * (a - b)
}

function compareTracks(key: TrackSortKey, a: TrackRow, b: TrackRow, sign: number): number {
  const x = a.track
  const y = b.track
  switch (key) {
    case 'title':
      return byText(x?.title, y?.title, sign) || byText(x?.artists[0]?.name, y?.artists[0]?.name, 1)
    case 'artist':
      return byText(x?.artists[0]?.name, y?.artists[0]?.name, sign) || byText(x?.title, y?.title, 1)
    case 'album':
      return (
        byText(x?.album?.name, y?.album?.name, sign) ||
        byNumber(x?.discNumber, y?.discNumber, 1) ||
        byNumber(x?.trackNumber, y?.trackNumber, 1) ||
        byText(x?.title, y?.title, 1)
      )
    case 'added':
      return byNumber(a.addedAt, b.addedAt, sign)
    case 'duration':
      return byNumber(x?.durationMs, y?.durationMs, sign)
    default:
      return 0
  }
}

/**
 * The rows as a sort view shows them. Equal rows keep their custom order, so sorting is
 * stable. `custom` returns the rows as they are.
 */
export function sortTrackRows(rows: readonly TrackRow[], view: SortView<TrackSortKey>): TrackRow[] {
  if (view.key === 'custom') return [...rows]
  const sign = view.direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compareTracks(view.key, a.row, b.row, sign) || a.index - b.index)
    .map(({ row }) => row)
}

function comparePlaylists(
  key: PlaylistSortKey,
  a: PlaylistSummary,
  b: PlaylistSummary,
  sign: number,
): number {
  switch (key) {
    case 'name':
      return byText(a.name, b.name, sign)
    case 'added':
      return byNumber(a.addedAt, b.addedAt, sign)
    case 'tracks':
      return byNumber(a.trackCount, b.trackCount, sign) || byText(a.name, b.name, 1)
    default:
      return 0
  }
}

/** The playlists as a sort view shows them; stable, like {@link sortTrackRows}. */
export function sortPlaylists(
  items: readonly PlaylistSummary[],
  view: SortView<PlaylistSortKey>,
): PlaylistSummary[] {
  if (view.key === 'custom') return [...items]
  const sign = view.direction === 'asc' ? 1 : -1
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => comparePlaylists(view.key, a.item, b.item, sign) || a.index - b.index)
    .map(({ item }) => item)
}
