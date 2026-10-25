import type { QueueContext, Track } from '@fxm/core'
import { Ellipsis, Heart, ListEnd, ListPlus, ListStart, Music, Pause, Play } from 'lucide-react'
import { memo, useEffect } from 'react'
import { IconButton, iconButtonClasses } from '../../components/ui/icon-button'
import { getLibrary } from '../../db/repo'
import { cn } from '../../lib/cn'
import { CoverArt } from '../library/cover-art'
import { artistNames, artworkUrl, trackDuration } from '../library/format'
import { failureText } from '../library/playlist-dialogs'
import { showStatus } from '../library/status'
import type { MenuItem } from '../library/ui/menu'
import { formatName, isLossless, qualityLabel } from './format'
import { failureMessage, formatSupport, getLocalPlayer, onTrackFailed } from './player'
import type { LocalTrack } from './tracks'
import type { LocalAudioFormat } from './types'

/** "Lossless" for FLAC, ALAC and WAV; nothing for any other format. */
export function LosslessBadge({ lossless }: { lossless: boolean }) {
  if (!lossless) return null
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-accent/70 px-1.5 text-2xs font-bold tracking-wide text-accent uppercase forced-colors:border-[CanvasText]">
      Lossless
    </span>
  )
}

/** Says why a local track didn't play, while the component is mounted. Use it once per screen. */
export function useFailureToasts(): void {
  useEffect(
    () =>
      onTrackFailed(({ item, error }) => {
        if (item.track.source !== 'local') return
        showStatus(failureMessage(error) ?? `Couldn’t play ${item.track.title}`)
      }),
    [],
  )
}

/** Whether this browser can play a format: anything but a sure `no`. */
export function isPlayableHere(format: Pick<LocalAudioFormat, 'codec' | 'container'>): boolean {
  return formatSupport(format) !== 'no'
}

/** The tracks of `items` this browser can play, which are all a queue should get. */
export function playableTracks(items: readonly LocalTrack[]): Track[] {
  return items.flatMap(({ track, file }) => (isPlayableHere(file.format) ? [track] : []))
}

/**
 * Plays `items` from `item`, leaving out what this browser can't play (the player would only
 * skip it). Call it from the click that asked for it.
 */
export function playFrom(
  items: readonly LocalTrack[],
  item: LocalTrack,
  context: QueueContext,
): void {
  if (!isPlayableHere(item.file.format)) {
    showStatus(`This browser can’t play ${formatName(item.file.format)} files`)
    return
  }
  const tracks = playableTracks(items)
  const startIndex = Math.max(
    0,
    tracks.findIndex((track) => track.id === item.track.id),
  )
  void getLocalPlayer().setQueue(tracks, { startIndex, context, shuffle: false })
}

/** Likes a track or removes its like, and says which. */
export function toggleLike(track: Track): void {
  getLibrary()
    .toggleLike(track)
    .then(
      (liked) =>
        showStatus(liked ? 'Saved to Liked songs' : `Removed ${track.title} from Liked songs`),
      (error: unknown) => showStatus(failureText(error)),
    )
}

/** The row menu's actions for a local track. Queueing is off for a format the browser can't play. */
export function trackMenuItems(
  { track, file }: LocalTrack,
  { liked, onAddToPlaylist }: { liked: boolean; onAddToPlaylist: (track: Track) => void },
): MenuItem[] {
  const playable = isPlayableHere(file.format)
  return [
    {
      id: 'next',
      label: 'Play next',
      icon: ListStart,
      disabled: !playable,
      onSelect: () => {
        getLocalPlayer().playNext([track])
        showStatus(`${track.title} plays next`)
      },
    },
    {
      id: 'queue',
      label: 'Add to queue',
      icon: ListEnd,
      disabled: !playable,
      onSelect: () => {
        getLocalPlayer().addToQueue([track])
        showStatus(`Added ${track.title} to the queue`)
      },
    },
    {
      id: 'playlist',
      label: 'Add to playlist…',
      icon: ListPlus,
      onSelect: () => onAddToPlaylist(track),
    },
    {
      id: 'like',
      label: liked ? 'Remove from Liked songs' : 'Save to Liked songs',
      icon: Heart,
      onSelect: () => toggleLike(track),
    },
  ]
}

/** What a row shows, as plain values, so the memo can compare them. */
export interface RowFields {
  id: string
  title: string
  artists: string
  album: string
  quality: string
  lossless: boolean
  /** False when this browser can't play the file's format (ALAC in Chromium, say). */
  playable: boolean
  duration: string
  /** The cover's URL. */
  cover: string | undefined
}

/** The fields of a row for `item`. */
export function rowFields({ track, file }: LocalTrack): RowFields {
  return {
    id: track.id,
    title: track.title,
    artists: artistNames(track),
    album: track.album?.name ?? '',
    quality: qualityLabel(file.format),
    lossless: isLossless(file.format),
    playable: isPlayableHere(file.format),
    duration: trackDuration(track),
    cover: artworkUrl(track.artwork, 80),
  }
}

export interface LocalTrackRowProps extends RowFields {
  /** Whether it is the player's current track. */
  current: boolean
  /** Whether the player plays (or loads) right now. */
  playing: boolean
  liked: boolean
  /** Its files can't be read right now (picked files after a reload): shown dimmed. */
  dimmed: boolean
  /** Whether its menu is open, for `aria-expanded`. */
  menuOpen: boolean
  onPlay: (id: string) => void
  onToggleLike: (id: string) => void
  onOpenMenu: (id: string, anchor: HTMLElement) => void
}

/**
 * One local file in a list: play button, cover, title and artists, album, quality, like, length
 * and menu. Memoized on plain values, so a scan that adds files re-renders only the new rows.
 */
export const LocalTrackRow = memo(function LocalTrackRow({
  id,
  title,
  artists,
  album,
  quality,
  lossless,
  playable,
  duration,
  cover,
  current,
  playing,
  liked,
  dimmed,
  menuOpen,
  onPlay,
  onToggleLike,
  onOpenMenu,
}: LocalTrackRowProps) {
  const active = current && playing
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-lg py-1.5 pr-1 [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto] hover:bg-text/5 sm:gap-3',
        (dimmed || !playable) && 'opacity-60',
      )}
    >
      <IconButton
        label={`${active ? 'Pause' : 'Play'} ${title}`}
        icon={active ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        size="sm"
        active={current}
        onClick={() => onPlay(id)}
      />
      <CoverArt src={cover} seed={id} icon={Music} rounded="sm" className="size-10" />
      <div className="min-w-0 flex-1">
        <p className={cn('truncate font-semibold', current && 'text-accent')}>{title}</p>
        <p className="flex min-w-0 items-center gap-2 text-sm text-text-muted">
          {playable ? (
            <LosslessBadge lossless={lossless} />
          ) : (
            <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border-strong px-1.5 text-2xs font-bold tracking-wide uppercase">
              Can’t play here
            </span>
          )}
          <span className="truncate">{artists || 'Unknown artist'}</span>
        </p>
      </div>
      <p className="hidden w-1/4 min-w-0 truncate text-sm text-text-muted lg:block">{album}</p>
      <p className="hidden w-44 shrink-0 truncate text-sm text-text-muted xl:block">{quality}</p>
      <span className="hidden md:block">
        <IconButton
          label={`Like ${title}`}
          icon={<Heart fill={liked ? 'currentColor' : 'none'} />}
          size="sm"
          pressed={liked}
          onClick={() => onToggleLike(id)}
        />
      </span>
      <span className="hidden w-11 shrink-0 text-right text-sm tabular-nums text-text-muted sm:block">
        {duration}
      </span>
      <button
        type="button"
        aria-label={`More options for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className={iconButtonClasses({ size: 'sm' })}
        onClick={(event) => onOpenMenu(id, event.currentTarget)}
      >
        <Ellipsis aria-hidden="true" />
      </button>
    </li>
  )
})
