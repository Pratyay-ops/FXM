import { type EntityId, formatId, parseId } from '@fxm/core'
import { Download, Heart, ListMusic, type LucideIcon } from 'lucide-react'
import type { PlaylistSummary } from '../../db/repo'
import { type FollowKind, isLocalPlaylistId } from '../../db/types'
import { albumPath, artistPath, playlistPath as sourcePlaylistPath } from '../search/catalog/links'
import { countLabel } from './format'

/**
 * The route of a playlist. A playlist of this library opens with its whole ID, colons kept
 * readable (`/playlist/local:playlist:…`); anything else unusual in it is escaped. A playlist
 * followed from a source opens the playlist page from search, which names it by source and
 * native ID (`/playlist/ytm:PL…`, see `features/search/catalog/links.ts`).
 */
export function playlistPath(id: EntityId<'playlist'>): string {
  if (!isLocalPlaylistId(id)) return sourcePlaylistPath(id)
  return `/playlist/${encodeURIComponent(id).replaceAll('%3A', ':')}`
}

/**
 * The route of a followed artist or saved album: its page from search, which names it by source
 * and native ID (`/artist/ytm:UC…`, `/album/ytm:MPREb_…`).
 */
export function followPath(
  kind: Exclude<FollowKind, 'playlist'>,
  id: EntityId<FollowKind>,
): string {
  const { source, nativeId } = parseId(id)
  return kind === 'artist'
    ? artistPath(formatId(source, 'artist', nativeId))
    : albumPath(formatId(source, 'album', nativeId))
}

/** The icon a playlist's placeholder artwork shows. */
export function playlistIcon(item: { system?: PlaylistSummary['system'] | undefined }): LucideIcon {
  if (item.system === 'liked') return Heart
  if (item.system === 'downloads') return Download
  return ListMusic
}

/** The line under a playlist's name: "Playlist · 12 songs", "Playlist · YouTube Music". */
export function playlistSubtitle(item: PlaylistSummary): string {
  if (item.origin === 'followed') return item.owner ? `Playlist · ${item.owner}` : 'Playlist'
  return `Playlist · ${countLabel(item.trackCount ?? 0, 'song')}`
}
