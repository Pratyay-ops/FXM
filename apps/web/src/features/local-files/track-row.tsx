import type { QueueContext, Track } from '@fxm/core'
import {
  AudioLines,
  Ellipsis,
  Heart,
  ListEnd,
  ListPlus,
  ListStart,
  Lock,
  type LucideIcon,
  Music,
  Pause,
  Play,
} from 'lucide-react'
import { memo, type ReactNode, useEffect } from 'react'
import { IconButton, iconButtonClasses } from '../../components/ui/icon-button'
import { getLibrary } from '../../db/repo'
import { cn } from '../../lib/cn'
import { CoverArt } from '../library/cover-art'
import { failureText } from '../library/failure'
import { artistNames, artworkUrl, trackDuration } from '../library/format'
import { showStatus } from '../library/status'
import type { MenuItem } from '../library/ui/menu'
import { convertedFromName, formatName, isLossless, qualityLabel } from './format'
import { failureMessage, formatSupport, getLocalPlayer, onTrackFailed } from './player'
import type { BlockedRoot } from './root-status'
import type { LocalTrack } from './tracks'
import type { LocalAudioFormat } from './types'

/** Roots whose songs can't play right now, by root ID (see `useBlockedRoots`). */
export type BlockedRoots = ReadonlyMap<string, BlockedRoot>

/**
 * "Lossless" for FLAC, ALAC and WAV; nothing for any other format, nor for a file converted from
 * lossy audio (its tier is its source's, so `lossless` is false for it).
 */
export function LosslessBadge({ lossless }: { lossless: boolean }) {
  if (!lossless) return null
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-accent/70 px-1.5 text-2xs font-bold tracking-wide text-accent uppercase forced-colors:border-[CanvasText]">
      Lossless
    </span>
  )
}

/** A badge in the row's own text color, e.g. "Can't play here". */
function RowBadge({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border-strong px-1.5 text-2xs font-bold tracking-wide uppercase forced-colors:border-[CanvasText]">
      {Icon && <Icon aria-hidden="true" className="size-3" />}
      {children}
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

/** Whether a local track can play now: a format this browser plays, from a root it can read. */
export function canPlayNow({ file }: LocalTrack, blocked?: BlockedRoots): boolean {
  return isPlayableHere(file.format) && !blocked?.has(file.rootId)
}

/**
 * The tracks of `items` that can play now, which are all a queue should get: a song of chosen
 * files the browser forgot would only stop or skip the queue when its turn came.
 */
export function playableTracks(items: readonly LocalTrack[], blocked?: BlockedRoots): Track[] {
  return items.flatMap((item) => (canPlayNow(item, blocked) ? [item.track] : []))
}

/**
 * Plays `items` from `item`, leaving out what can't play now (see {@link playableTracks}).
 * Clicked on a song that can't, it says why instead. Call it from the click that asked for it.
 */
export function playFrom(
  items: readonly LocalTrack[],
  item: LocalTrack,
  context: QueueContext,
  blocked?: BlockedRoots,
): void {
  const why = blocked?.get(item.file.rootId)
  if (why !== undefined) {
    showStatus(why.message)
    return
  }
  if (!isPlayableHere(item.file.format)) {
    showStatus(`This browser can’t play ${formatName(item.file.format)} files`)
    return
  }
  const tracks = playableTracks(items, blocked)
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

/** The row menu's actions for a local track. Queueing is off for a song that can't play now. */
export function trackMenuItems(
  item: LocalTrack,
  {
    liked,
    onAddToPlaylist,
    blocked,
  }: { liked: boolean; onAddToPlaylist: (track: Track) => void; blocked?: BlockedRoots },
): MenuItem[] {
  const { track } = item
  const playable = canPlayNow(item, blocked)
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
  /**
   * The codec a file converted from lossy audio came from, e.g. `Opus` (its tags say so): the
   * row says "From Opus" where a lossless file says "Lossless". `undefined` for other files.
   */
  converted: string | undefined
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
    converted: convertedFromName(file.format),
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
  /**
   * The badge of a song whose files can't be read right now (chosen files after a reload, a
   * folder that is gone), e.g. "Choose again"; `undefined` when they can.
   */
  blocked: string | undefined
  /** Whether its menu is open, for `aria-expanded`. */
  menuOpen: boolean
  onPlay: (id: string) => void
  onToggleLike: (id: string) => void
  onOpenMenu: (id: string, anchor: HTMLElement) => void
}

/** The play button's name: Play, Pause while it plays, Resume while it is paused. */
function playLabel(title: string, current: boolean, playing: boolean): string {
  if (!current) return `Play ${title}`
  return `${playing ? 'Pause' : 'Resume'} ${title}`
}

/**
 * One local file in a list: play button, cover, title and artists, album, quality, like, length
 * and menu. Memoized on plain values, so a scan that adds files re-renders only the new rows.
 *
 * A song that can't play here or now keeps its text at full contrast: only its cover fades, its
 * title turns muted and a badge says why. The current song has an icon by its title, so it
 * stands out without color too (forced colors, say).
 */
export const LocalTrackRow = memo(function LocalTrackRow({
  id,
  title,
  artists,
  album,
  quality,
  lossless,
  converted,
  playable,
  duration,
  cover,
  current,
  playing,
  liked,
  blocked,
  menuOpen,
  onPlay,
  onToggleLike,
  onOpenMenu,
}: LocalTrackRowProps) {
  const active = current && playing
  const unplayable = blocked !== undefined || !playable
  let badge: ReactNode
  if (blocked !== undefined) badge = <RowBadge icon={Lock}>{blocked}</RowBadge>
  else if (!playable) badge = <RowBadge>Can’t play here</RowBadge>
  else if (converted !== undefined) badge = <RowBadge>From {converted}</RowBadge>
  else badge = <LosslessBadge lossless={lossless} />
  return (
    <li
      aria-current={current ? 'true' : undefined}
      className="flex items-center gap-2 rounded-lg py-1.5 pr-1 [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto] hover:bg-text/5 sm:gap-3"
    >
      <IconButton
        label={playLabel(title, current, active)}
        icon={active ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        size="sm"
        active={current}
        onClick={() => onPlay(id)}
      />
      <CoverArt
        src={cover}
        seed={id}
        icon={Music}
        rounded="sm"
        className={cn('size-10', unplayable && 'opacity-50')}
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'flex min-w-0 items-center gap-1.5 font-semibold',
            current ? 'text-accent' : unplayable && 'text-text-muted',
          )}
        >
          {current && <AudioLines aria-hidden="true" className="size-4 shrink-0" />}
          <span className="truncate">{title}</span>
        </p>
        <p className="flex min-w-0 items-center gap-2 text-sm text-text-muted">
          {badge}
          <span className="truncate">{artists || 'Unknown artist'}</span>
        </p>
      </div>
      <p className="hidden w-1/4 min-w-0 truncate text-sm text-text-muted lg:block">{album}</p>
      <p title={quality} className="hidden w-44 shrink-0 truncate text-sm text-text-muted xl:block">
        {quality}
      </p>
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
