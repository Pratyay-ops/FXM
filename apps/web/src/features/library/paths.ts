import type { EntityId } from '@fxm/core'
import { Download, Heart, ListMusic, type LucideIcon } from 'lucide-react'
import type { PlaylistSummary } from '../../db/repo'
import type { FollowKind } from '../../db/types'
import { countLabel } from './format'

/**
 * The route of a playlist: `/playlist/<id>`. Colons stay readable (`local:playlist:…`);
 * anything else unusual in an ID is escaped.
 */
export function playlistPath(id: EntityId<'playlist'>): string {
  return `/playlist/${encodeURIComponent(id).replaceAll('%3A', ':')}`
}

/** The route of a followed artist or saved album. */
export function followPath(kind: Exclude<FollowKind, 'playlist'>, id: string): string {
  return `/${kind}/${encodeURIComponent(id).replaceAll('%3A', ':')}`
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
