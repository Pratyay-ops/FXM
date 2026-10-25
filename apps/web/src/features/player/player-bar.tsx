import { ListMusic } from 'lucide-react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { Artwork } from '../../components/ui/artwork'
import { iconButtonClasses } from '../../components/ui/icon-button'
import { cn } from '../../lib/cn'
import { CATALOG_MODE_OPTIONS } from '../settings/options'
import { useSettingsStore } from '../settings/settings-store'
import { LikeButton, PlayerControls, PlayPauseButton, SeekBar, VolumeControl } from './controls'
import { PLACEHOLDER_TRACK, usePlayerStore } from './player-store'

const NOW_PLAYING_LABEL = `Open now playing: ${PLACEHOLDER_TRACK.title} by ${PLACEHOLDER_TRACK.artist}`

/** Shows the catalog mode in use; links to Settings, where it is changed. */
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
        'relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-semibold whitespace-nowrap text-text-muted transition-colors after:absolute after:inset-x-0 after:-inset-y-1.5 hover:border-border-strong hover:text-text',
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {option.label}
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
  return (
    <section
      aria-label="Player"
      className="fixed inset-x-safe bottom-0 z-40 hidden border-t border-border bg-surface pb-safe shadow-[0_-12px_32px_-20px_var(--shadow-color)] md:block"
    >
      <div className="grid h-player grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)] items-center gap-3 px-3 lg:gap-6 lg:px-4">
        <div className="flex min-w-0 items-center gap-1">
          <Link
            to="/now-playing"
            aria-label={NOW_PLAYING_LABEL}
            className="group flex min-w-0 items-center gap-3 rounded-md pr-1"
          >
            <Artwork seed={PLACEHOLDER_TRACK.seed} className="size-14 shadow-md" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold group-hover:underline">
                {PLACEHOLDER_TRACK.title}
              </span>
              <span className="block truncate text-xs text-text-muted">
                {PLACEHOLDER_TRACK.artist}
              </span>
            </span>
          </Link>
          <LikeButton />
        </div>

        <div className="flex w-full max-w-[42rem] flex-col items-center gap-0.5 justify-self-center">
          <PlayerControls />
          <SeekBar />
        </div>

        <div className="flex min-w-0 items-center justify-end gap-1">
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
          aria-label={NOW_PLAYING_LABEL}
          // Inset focus ring: the card clips anything drawn outside it.
          className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-md focus-visible:-outline-offset-2"
        >
          <Artwork seed={PLACEHOLDER_TRACK.seed} rounded="sm" className="size-10" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{PLACEHOLDER_TRACK.title}</span>
            <span className="block truncate text-xs text-text-muted">
              {PLACEHOLDER_TRACK.artist}
            </span>
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
