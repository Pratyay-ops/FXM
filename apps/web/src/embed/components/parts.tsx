import { formatTime } from '@fxm/player'
import {
  ExternalLink,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import { useState } from 'react'
import { Artwork } from '../../components/ui/artwork'
import { buttonClasses } from '../../components/ui/button'
import { IconButton } from '../../components/ui/icon-button'
import { LogoMark } from '../../components/ui/logo'
import { RangeSlider } from '../../components/ui/range-slider'
import { cn } from '../../lib/cn'
import { type EmbedView, pickArtwork } from '../view'

/** What the visitor can do. Absent in the share dialog's preview, which only shows. */
export interface EmbedActions {
  /** Resumes, or plays the track at `index` from its start. */
  play(index?: number): void
  /** Plays or pauses. */
  toggle(): void
  /** Skips to the next track. */
  next(): void
  /** Goes back a track (or to the start of this one). */
  previous(): void
  /** Jumps to `ms` into the current track. */
  seek(ms: number): void
  /** Loads the content again after a failure. */
  retry(): void
}

/** Links leave the embed: they open a new tab, and the embedding page learns nothing. */
const EXTERNAL = { target: '_blank', rel: 'noopener noreferrer' } as const

const RADII = { md: 'rounded-md', lg: 'rounded-lg' } as const

/** Cover art, or the placeholder when there is none or it fails to load. */
export function Cover({
  view,
  pixels,
  rounded,
  className,
}: {
  view: Pick<EmbedView, 'artwork' | 'seed'>
  /** The rendered size in CSS pixels, to pick the artwork size. */
  pixels: number
  /** Corner radius. */
  rounded: keyof typeof RADII
  /** Size classes. */
  className: string
}) {
  const density = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 3)
  const url = pickArtwork(view.artwork, pixels, density)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  if (url === undefined || failed === url) {
    return <Artwork seed={view.seed} rounded={rounded} className={className} />
  }
  return (
    <img
      src={url}
      alt=""
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(url)}
      className={cn('shrink-0 object-cover', RADII[rounded], className)}
    />
  )
}

/** The FXM mark, linking to the item in the web app. */
export function BrandLink({ view, className }: { view: EmbedView; className?: string }) {
  return (
    <a
      href={view.links.open}
      {...EXTERNAL}
      aria-label="Open in FXM (opens a new tab)"
      title="Open in FXM"
      className={cn('shrink-0 rounded-md', className)}
    >
      <LogoMark className="size-6" />
    </a>
  )
}

/** Whether the player shows "pause": it plays, or is about to. */
export function isActive(view: EmbedView): boolean {
  return view.status === 'playing' || view.status === 'loading'
}

/** The play and pause button. */
export function PlayButton({
  view,
  actions,
  size,
}: {
  view: EmbedView
  actions: EmbedActions | undefined
  size: 'md' | 'lg'
}) {
  const active = isActive(view)
  const busy = view.status === 'loading' || (active && view.buffering)
  const Icon = busy ? LoaderCircle : active ? Pause : Play
  const label = active ? 'Pause' : view.title ? `Play ${view.title}` : 'Play'
  return (
    <IconButton
      label={label}
      icon={
        <Icon
          fill={busy ? 'none' : 'currentColor'}
          strokeWidth={busy ? 2 : 0}
          // The play triangle's visual center sits left of its box: nudge it right.
          className={cn(busy && 'animate-spin motion-reduce:animate-none', !active && 'ml-0.5')}
        />
      }
      size="custom"
      variant="accent"
      disabled={!view.canPlay}
      onClick={() => actions?.toggle()}
      className={size === 'lg' ? 'size-12 [&_svg]:size-6' : 'size-10 [&_svg]:size-5'}
    />
  )
}

/** Previous and next, for albums and playlists. */
export function SkipButtons({
  view,
  actions,
  className,
}: {
  view: EmbedView
  actions: EmbedActions | undefined
  className?: string
}) {
  if (!view.canSkip) return null
  return (
    <div className={cn('flex items-center', className)}>
      <IconButton
        label="Previous track"
        icon={<SkipBack fill="currentColor" />}
        size="custom"
        variant="plain"
        disabled={!view.canPlay}
        onClick={() => actions?.previous()}
        className="size-touch [&_svg]:size-5"
      />
      <IconButton
        label="Next track"
        icon={<SkipForward fill="currentColor" />}
        size="custom"
        variant="plain"
        disabled={!view.canPlay}
        onClick={() => actions?.next()}
        className="size-touch [&_svg]:size-5"
      />
    </div>
  )
}

/** The seek bar with the elapsed and total time. */
export function SeekBar({ view, actions }: { view: EmbedView; actions: EmbedActions | undefined }) {
  const duration = view.durationMs ?? 0
  const position = Math.min(view.positionMs, duration || view.positionMs)
  const elapsed = formatTime(position / 1000)
  const total = formatTime(duration / 1000)
  return (
    <div className="flex items-center gap-2 text-2xs text-text-muted tabular-nums">
      <span className="w-9 text-right" aria-hidden="true">
        {elapsed}
      </span>
      <RangeSlider
        label="Seek"
        min={0}
        max={Math.max(duration, 1)}
        step={1000}
        value={position}
        valueText={`${elapsed} of ${total}`}
        disabled={!view.canPlay || duration === 0}
        onValueChange={(value) => actions?.seek(value)}
        className="min-w-0 flex-1"
      />
      <span className="w-9" aria-hidden="true">
        {total}
      </span>
    </div>
  )
}

/** A thin progress line, for the compact layout. */
export function ProgressLine({ view }: { view: EmbedView }) {
  const duration = view.durationMs ?? 0
  const fraction = duration > 0 ? Math.min(1, view.positionMs / duration) : 0
  return (
    <div aria-hidden="true" className="h-1 w-full overflow-hidden rounded-full bg-border-strong/40">
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300 ease-linear"
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  )
}

/** Why something doesn't play here, with what helps: get FXM, open FXM, or try again. */
export function MessageBlock({
  view,
  actions,
  compact = false,
}: {
  view: EmbedView
  actions: EmbedActions | undefined
  compact?: boolean
}) {
  const { message } = view
  if (message === undefined) return null
  const link = buttonClasses({
    variant: 'secondary',
    className: compact ? 'h-8 px-3 text-xs' : 'h-9 px-4 text-xs',
  })
  return (
    <div className={cn('flex min-w-0 items-center gap-3', compact ? 'flex-row' : 'flex-wrap')}>
      <p
        className={cn(
          'min-w-0 flex-1 text-text-muted',
          compact ? 'line-clamp-2 text-xs' : 'text-sm',
        )}
      >
        {message.text}
      </p>
      {message.action === 'install' && (
        <a href={view.links.install} {...EXTERNAL} className={link}>
          Get FXM
          <ExternalLink aria-hidden="true" />
        </a>
      )}
      {message.action === 'open' && (
        <a href={view.links.open} {...EXTERNAL} className={link}>
          Open in FXM
          <ExternalLink aria-hidden="true" />
        </a>
      )}
      {message.action === 'retry' && (
        <button type="button" onClick={() => actions?.retry()} className={link}>
          <RotateCcw aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  )
}

/** Credits for a free-source track: who provides it, and its licence. */
export function AttributionLine({ view }: { view: EmbedView }) {
  const { attribution } = view
  if (attribution === undefined) return null
  return (
    <p className="truncate text-2xs text-text-muted">
      From{' '}
      <a href={attribution.pageUrl} {...EXTERNAL} className="underline underline-offset-2">
        {attribution.provider}
      </a>
      {attribution.licenseUrl !== undefined && (
        <>
          {' · '}
          <a href={attribution.licenseUrl} {...EXTERNAL} className="underline underline-offset-2">
            Licence
          </a>
        </>
      )}
    </p>
  )
}

/** An album's or playlist's tracks; picking one plays it. */
export function TrackList({
  view,
  actions,
}: {
  view: EmbedView
  actions: EmbedActions | undefined
}) {
  return (
    <ol aria-label="Tracks" className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
      {view.rows.map((row, index) => {
        const current = index === view.currentIndex && view.status !== 'idle'
        return (
          <li key={row.key}>
            <button
              type="button"
              aria-current={current ? 'true' : undefined}
              aria-label={`Play ${row.title}${row.artists ? ` by ${row.artists}` : ''}`}
              disabled={!view.canPlay}
              onClick={() => actions?.play(index)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-text/8 disabled:pointer-events-none focus-visible:-outline-offset-2',
                current && 'bg-text/5',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'w-5 shrink-0 text-right text-xs tabular-nums',
                  current ? 'font-bold text-accent' : 'text-text-muted',
                )}
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-sm',
                    current ? 'font-semibold text-accent' : '',
                  )}
                >
                  {row.title}
                </span>
                {row.artists && (
                  <span className="block truncate text-xs text-text-muted">{row.artists}</span>
                )}
              </span>
              {row.durationMs !== undefined && (
                <span aria-hidden="true" className="shrink-0 text-xs text-text-muted tabular-nums">
                  {formatTime(row.durationMs / 1000)}
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ol>
  )
}
