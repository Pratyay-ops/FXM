import { CircleAlert, ListMusic } from 'lucide-react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { Artwork } from '../../components/ui/artwork'
import { iconButtonClasses } from '../../components/ui/icon-button'
import { cn } from '../../lib/cn'
import { SoundButton } from '../audio-effects/sound-button'
import { useCurrentItem, usePlayerState } from '../now-playing/playback'
import { TrackArtwork } from '../now-playing/track-artwork'
import { CATALOG_MODE_OPTIONS } from '../settings/options'
import { useSettingsStore } from '../settings/settings-store'
import { LikeButton, PlayerControls, PlayPauseButton, SeekBar, VolumeControl } from './controls'
import { usePlayerStore } from './player-store'

/**
 * The current track as the bars show it, or "Not playing" while the queue is empty. When
 * playback stopped on a problem, the bars say "Couldn’t play" instead of the artists (Now
 * playing says why, and the app's announcer tells screen readers).
 */
function useNowPlaying() {
  const item = useCurrentItem()
  const failed = usePlayerState((state) => state.error !== undefined)
  if (item === undefined) {
    return { title: 'Not playing', artists: '', failed: false, label: 'Open now playing' }
  }
  const { title } = item.track
  const artists = item.track.artists.map((artist) => artist.name).join(', ')
  const label = `Open now playing: ${title} by ${artists}`
  return { title, artists, failed, label: failed ? `${label}. Couldn’t play` : label }
}

/** The bars' second line: the artists, or that the track couldn't play. */
function Subtitle({ artists, failed }: { artists: string; failed: boolean }) {
  if (!failed) return <span className="block truncate text-xs text-text-muted">{artists}</span>
  return (
    <span className="flex items-center gap-1 text-xs font-semibold text-danger">
      <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">Couldn’t play</span>
    </span>
  )
}

/** The current track's cover, or a neutral placeholder while nothing plays. */
function BarArtwork({ size, className }: { size: number; className: string }) {
  const item = useCurrentItem()
  const rounded = size < 48 ? 'sm' : 'md'
  if (item === undefined) {
    return <Artwork seed="fxm-now-playing" rounded={rounded} className={className} />
  }
  return (
    <TrackArtwork
      images={item.track.artwork}
      seed={item.track.id}
      size={size}
      rounded={rounded}
      className={className}
    />
  )
}

/**
 * Shows the catalog mode in use; links to Settings, where it is changed. Below
 * 1280px the bar is too narrow for "Music + Video", so only the icon shows there
 * (the link's label still names the mode).
 */
export function ModeIndicator({ className }: { className?: string }) {
  const mode = useSettingsStore((state) => state.catalogMode)
  const option = CATALOG_MODE_OPTIONS.find((candidate) => candidate.value === mode)
  if (!option) return null
  const Icon = option.icon
  return (
    <Link
      to="/settings"
      aria-label={`Catalog mode: ${option.label}. Change it in Settings`}
      className={cn(
        // The ::after extends the hit area to 44px without changing the look.
        'relative inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full border border-border text-xs font-semibold whitespace-nowrap text-text-muted transition-colors after:absolute after:-inset-1.5 hover:border-border-strong hover:text-text max-xl:w-8 xl:px-3',
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="max-xl:sr-only">{option.label}</span>
    </Link>
  )
}

function QueueButton() {
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const active = pathname === '/now-playing' && params.get('tab') === 'queue'
  return (
    <Link
      to="/now-playing?tab=queue"
      aria-label="Queue"
      aria-current={active ? 'page' : undefined}
      className={iconButtonClasses({ size: 'sm', highlighted: active, dot: true })}
    >
      <ListMusic aria-hidden="true" />
    </Link>
  )
}

/** The persistent player along the bottom from 768px up. */
export function PlayerBar() {
  const { title, artists, failed, label } = useNowPlaying()
  return (
    <section
      aria-label="Player"
      className="fixed inset-x-safe bottom-0 z-40 hidden border-t border-border bg-surface pb-safe shadow-[0_-12px_32px_-20px_var(--shadow-color)] md:block"
    >
      {/* The right column never gets narrower than its buttons, so they can't spill into the seek bar. */}
      <div className="grid h-player grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(max-content,1fr)] items-center gap-3 px-3 lg:gap-6 lg:px-4">
        <div className="flex min-w-0 items-center gap-1">
          <Link
            to="/now-playing"
            aria-label={label}
            className="group flex min-w-0 items-center gap-3 rounded-md pr-1"
          >
            <BarArtwork size={56} className="size-14 shadow-md" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold group-hover:underline">
                {title}
              </span>
              <Subtitle artists={artists} failed={failed} />
            </span>
          </Link>
          <LikeButton />
        </div>

        <div className="flex w-full max-w-[42rem] flex-col items-center gap-0.5 justify-self-center">
          <PlayerControls />
          <SeekBar />
        </div>

        <div className="flex min-w-0 items-center justify-end gap-1">
          <SoundButton />
          <QueueButton />
          <VolumeControl />
          <ModeIndicator className="ml-1" />
        </div>
      </div>
    </section>
  )
}

/** Compact player above the tab bar on phones; tapping it opens Now Playing. */
export function MiniPlayer() {
  const { title, artists, failed, label } = useNowPlaying()
  const position = usePlayerStore((state) => state.position)
  const duration = usePlayerStore((state) => state.duration)
  const progress = duration > 0 ? (position / duration) * 100 : 0
  return (
    <section
      aria-label="Player"
      className="fixed inset-x-safe bottom-[calc(var(--spacing-tabbar)+var(--safe-bottom))] z-40 bg-linear-to-t from-background from-40% to-transparent px-2 pt-3 pb-2 md:hidden"
    >
      <div className="relative flex h-mini items-center gap-1 overflow-hidden rounded-lg bg-elevated pr-1 pl-2 shadow-lg">
        <Link
          to="/now-playing"
          aria-label={label}
          // Inset focus ring: the card clips anything drawn outside it.
          className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-md focus-visible:-outline-offset-2"
        >
          <BarArtwork size={40} className="size-10" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{title}</span>
            <Subtitle artists={artists} failed={failed} />
          </span>
        </Link>
        <LikeButton />
        <PlayPauseButton appearance="mini" />
        <div
          aria-hidden="true"
          className="absolute inset-x-2 bottom-0 h-0.5 overflow-hidden rounded-full bg-text/15"
        >
          <div className="h-full rounded-full bg-text" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </section>
  )
}
