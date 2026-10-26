import type { Album, EntityId, Playlist, Track } from '@fxm/core'
import { Share2 } from 'lucide-react'
import { embedTargetOf } from '../../embed/target'
import { joinArtists, type PreviewInfo } from '../../embed/view'
import type { MenuAction } from '../search/catalog/action-menu'
import { canShare, useShareStore } from './share-store'

/**
 * The "Share" entry of a "More options" menu, which opens the share dialog with `info` for its
 * preview. None for an entity no embed can show (an artist, a Spotify album, a local file), or
 * that the app doesn't offer to share yet (`canShare`: in production builds, until the embed
 * can play its source).
 */
export function shareMenuItems(id: EntityId, info: PreviewInfo): MenuAction[] {
  const target = embedTargetOf(id)
  if (target === undefined || !canShare(target)) return []
  const open = () => useShareStore.getState().open({ target, info })
  return [{ key: 'share', label: 'Share', icon: Share2, onSelect: open }]
}

/** The "Share" entry of an album page's menu, previewing the `tracks` that play in its mode. */
export function albumShareItems(album: Album, tracks: readonly Track[]): MenuAction[] {
  return shareMenuItems(album.id, {
    title: album.name,
    subtitle: joinArtists(album.artists),
    artwork: album.artwork,
    tracks,
  })
}

/**
 * The "Share" entry of a playlist page's menu, previewing the `tracks` loaded so far that play
 * in its mode, of `total` in all when the source says.
 */
export function playlistShareItems(
  playlist: Playlist,
  tracks: readonly Track[],
  total: number | undefined,
): MenuAction[] {
  return shareMenuItems(playlist.id, {
    title: playlist.name,
    ...(playlist.owner === undefined ? {} : { subtitle: playlist.owner.name }),
    artwork: playlist.artwork,
    tracks,
    ...(total === undefined ? {} : { trackCount: total }),
  })
}
