import { type EntityId, entityKey, type QueueContext, type Track } from '@fxm/core'
import { ChevronDown } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { useLive } from '../../db/hooks'
import { LIKED_PLAYLIST_ID } from '../../db/types'
import { countLabel } from '../library/format'
import { AddToPlaylistDialog } from '../library/playlist-dialogs'
import { MenuPopup } from '../library/ui/menu'
import { nowPlayingStatusOf, useCurrentTrack } from '../now-playing/current-track'
import { getLocalPlayer } from './player'
import {
  type BlockedRoots,
  LocalTrackRow,
  playFrom,
  rowFields,
  toggleLike,
  trackMenuItems,
} from './track-row'
import type { LocalTrack } from './tracks'

/** How many rows a list shows at first, and how many more each "Show more" adds. */
export const LIST_PAGE_SIZE = 200

export interface LocalTrackListProps {
  /** The tracks, in the order they show and play. */
  tracks: readonly LocalTrack[]
  /** What the queue says it plays from. */
  context: QueueContext
  /** The list's accessible name, e.g. "Songs in local files". */
  label: string
  /** Roots whose songs can't play right now: their rows say why, and stay out of queues. */
  blocked?: BlockedRoots
  /** Rows shown at first. */
  pageSize?: number
}

/** The liked tracks, as entity keys, from one live query for the whole list. */
function useLikedKeys(): ReadonlySet<string> {
  const live = useLive((repo) => repo.getOrder(LIKED_PLAYLIST_ID), [])
  return useMemo(
    () => new Set(live.status === 'ready' ? live.data.map((id) => entityKey(id as EntityId)) : []),
    [live],
  )
}

/**
 * Local files as a list: play from any row (the list plays in its order from there), pause the
 * one playing, like, and a menu with Play next, Add to queue and Add to playlist. Long lists show
 * {@link LIST_PAGE_SIZE} rows at a time.
 */
export function LocalTrackList({
  tracks,
  context,
  label,
  blocked,
  pageSize = LIST_PAGE_SIZE,
}: LocalTrackListProps) {
  const [shown, setShown] = useState(pageSize)
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null)
  const [adding, setAdding] = useState<Track[] | null>(null)
  const liked = useLikedKeys()
  // The current track's identity and status only: no re-render on a playback tick.
  const current = useCurrentTrack()
  const byId = useMemo(
    () => new Map(tracks.map((item) => [item.track.id as string, item])),
    [tracks],
  )
  // The row callbacks read the latest list through a ref, so they never change and a scan that
  // adds files, or a new track playing, re-renders only the rows whose values changed.
  const latest = useRef({ tracks, byId, context, blocked, playingId: current?.id })
  latest.current = { tracks, byId, context, blocked, playingId: current?.id }

  const play = useCallback((id: string) => {
    const { tracks: list, byId: items, context: from, blocked: off, playingId } = latest.current
    if (playingId === id) {
      void getLocalPlayer().toggle()
      return
    }
    const item = items.get(id)
    if (item !== undefined) playFrom(list, item, from, off)
  }, [])

  const like = useCallback((id: string) => {
    const item = latest.current.byId.get(id)
    if (item !== undefined) toggleLike(item.track)
  }, [])

  const openMenu = useCallback((id: string, anchor: HTMLElement) => setMenu({ id, anchor }), [])
  const closeMenu = useCallback(
    (returnFocus: boolean) => {
      const anchor = menu?.anchor
      setMenu(null)
      if (returnFocus && anchor) requestAnimationFrame(() => anchor.isConnected && anchor.focus())
    },
    [menu],
  )

  const menuItem = menu === null ? undefined : byId.get(menu.id)
  const visible = tracks.slice(0, shown)
  const more = tracks.length - visible.length

  return (
    <div className="space-y-2">
      <ol aria-label={label} className="-mx-1">
        {visible.map((item) => (
          <LocalTrackRow
            key={item.track.id}
            {...rowFields(item)}
            nowPlaying={nowPlayingStatusOf(current, item.track.id)}
            liked={liked.has(entityKey(item.track.id))}
            blocked={blocked?.get(item.file.rootId)?.badge}
            menuOpen={menu?.id === item.track.id}
            onPlay={play}
            onToggleLike={like}
            onOpenMenu={openMenu}
          />
        ))}
      </ol>
      {more > 0 && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            className={buttonClasses({ variant: 'secondary' })}
            onClick={() => setShown((count) => count + pageSize)}
          >
            <ChevronDown aria-hidden="true" />
            Show {countLabel(Math.min(more, pageSize), 'more song', 'more songs')}
          </button>
        </div>
      )}
      {menu && menuItem && (
        <MenuPopup
          anchor={menu.anchor}
          items={trackMenuItems(menuItem, {
            liked: liked.has(entityKey(menuItem.track.id)),
            onAddToPlaylist: (track) => setAdding([track]),
            ...(blocked === undefined ? {} : { blocked }),
          })}
          label={`More options for ${menuItem.track.title}`}
          onClose={closeMenu}
        />
      )}
      <AddToPlaylistDialog tracks={adding} onClose={() => setAdding(null)} />
    </div>
  )
}
