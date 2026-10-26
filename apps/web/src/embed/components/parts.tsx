import { formatTime } from '@fxm/player'
import {
  Download,
  ExternalLink,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  ScrollText,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Artwork } from '../../components/ui/artwork'
import { buttonClasses } from '../../components/ui/button'
import { IconButton, iconButtonClasses } from '../../components/ui/icon-button'
import { LogoMark } from '../../components/ui/logo'
import {
  NowPlayingBars,
  type NowPlayingStatus,
  nowPlayingLabel,
} from '../../components/ui/now-playing-marker'
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

/** Said after the name of a link that opens a new tab. */
const NEW_TAB = ' (opens a new tab)'

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
      // A 44 px target around the 24 px mark.
      className={cn('-m-2.5 shrink-0 rounded-lg p-2.5', className)}
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
      className={size === 'lg' ? 'size-12 [&_svg]:size-6' : 'size-touch [&_svg]:size-5'}
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

/**
 * Why something doesn't play here, or why the last track didn't: the full text, or with `short`
 * the few words for where room is short.
 */
export function MessageText({
  view,
  short = false,
  className,
}: {
  view: EmbedView
  short?: boolean
  className?: string
}) {
  if (view.message === undefined) return null
  return (
    <p className={cn('min-w-0 text-text-muted', className)}>
      {short ? view.message.short : view.message.text}
    </p>
  )
}

/**
 * Where a message's action has room for its words: from 25rem in a card, from 30rem in the
 * compact layout, measured on the player itself (a container query), so the share dialog's
 * preview matches the iframe. Below that it is a 44 px icon button. Each shape sits in a
 * wrapper that only switches it on or off (`display: contents`), so the design system's
 * button classes stay as they are.
 */
const ACTION_SHAPES = {
  card: { narrow: 'contents @min-[25rem]:hidden', wide: 'hidden @min-[25rem]:contents' },
  compact: { narrow: 'contents @min-[30rem]:hidden', wide: 'hidden @min-[30rem]:contents' },
} as const

/** One action in both shapes: an icon button, and a button with words. */
function ActionShapes({
  layout,
  name,
  icon,
  wide,
  render,
}: {
  layout: keyof typeof ACTION_SHAPES
  /** The accessible name, the same in both shapes. */
  name: string
  /** The icon of the narrow shape. */
  icon: ReactNode
  /** The content of the wide shape: words and an icon. */
  wide: ReactNode
  /** Renders the link or button with its class names and content. */
  render: (className: string, content: ReactNode, label?: string) => ReactNode
}) {
  const shapes = ACTION_SHAPES[layout]
  const narrow = iconButtonClasses({
    size: 'custom',
    variant: 'solid',
    className: 'size-touch [&_svg]:size-5',
  })
  return (
    <>
      <span className={shapes.narrow}>{render(narrow, icon, name)}</span>
      <span className={shapes.wide}>{render(buttonClasses({ variant: 'secondary' }), wide)}</span>
    </>
  )
}

/** What helps with the message: get FXM (the install hint), open FXM, or try again. */
export function MessageAction({
  view,
  actions,
  layout,
}: {
  view: EmbedView
  actions: EmbedActions | undefined
  layout: 'card' | 'compact'
}) {
  const action = view.message?.action
  if (action === undefined) return null
  if (action === 'retry') {
    return (
      <ActionShapes
        layout={layout}
        name="Try again"
        icon={<RotateCcw aria-hidden="true" />}
        wide={
          <>
            <RotateCcw aria-hidden="true" />
            Try again
          </>
        }
        render={(className, content, label) => (
          <button
            type="button"
            aria-label={label}
            onClick={() => actions?.retry()}
            className={className}
          >
            {content}
          </button>
        )}
      />
    )
  }
  const words = action === 'install' ? 'Get FXM' : 'Open in FXM'
  const href = action === 'install' ? view.links.install : view.links.open
  return (
    <ActionShapes
      layout={layout}
      name={`${words}${NEW_TAB}`}
      icon={
        action === 'install' ? <Download aria-hidden="true" /> : <ExternalLink aria-hidden="true" />
      }
      wide={
        <>
          {words}
          <ExternalLink aria-hidden="true" />
          <span className="sr-only">{NEW_TAB}</span>
        </>
      }
      render={(className, content, label) => (
        <a href={href} {...EXTERNAL} aria-label={label} className={className}>
          {content}
        </a>
      )}
    />
  )
}

/**
 * A credit's link. Its focus ring sits inside it and its padding makes the target taller, so
 * a line that clips its overflow sideways never cuts the ring.
 */
const CREDIT_LINK =
  'rounded-sm py-1 underline underline-offset-2 focus-visible:-outline-offset-1 hover:text-text'

/** Credits for a free-source track in the card: who provides it, and its licence. */
export function AttributionLine({ view }: { view: EmbedView }) {
  const { attribution } = view
  if (attribution === undefined) return null
  return (
    // Clipped sideways only, so the links' focus rings show above and below the line.
    <p className="shrink-0 overflow-x-clip text-xs text-ellipsis whitespace-nowrap text-text-muted">
      From{' '}
      {attribution.pageUrl === undefined ? (
        attribution.provider
      ) : (
        <a href={attribution.pageUrl} {...EXTERNAL} className={CREDIT_LINK}>
          {attribution.provider}
          <span className="sr-only">{NEW_TAB}</span>
        </a>
      )}
      {attribution.licenseUrl !== undefined && (
        <>
          {' · '}
          <a href={attribution.licenseUrl} {...EXTERNAL} className={CREDIT_LINK}>
            Licence
            <span className="sr-only">{NEW_TAB}</span>
          </a>
        </>
      )}
    </p>
  )
}

/**
 * The compact layout's credits, after the artists on its second line: the provider, which
 * shortens with an ellipsis when room is short (clipped sideways only, so its focus ring
 * shows), and the licence as a small icon that never shrinks.
 */
export function CompactCredits({ view }: { view: EmbedView }) {
  const { attribution } = view
  if (attribution === undefined) return null
  return (
    <>
      <span className="min-w-0 overflow-x-clip text-ellipsis">
        <span className="sr-only">From </span>
        {attribution.pageUrl === undefined ? (
          attribution.provider
        ) : (
          <a href={attribution.pageUrl} {...EXTERNAL} className={CREDIT_LINK}>
            {attribution.provider}
            <span className="sr-only">{NEW_TAB}</span>
          </a>
        )}
      </span>
      {attribution.licenseUrl !== undefined && (
        <a
          href={attribution.licenseUrl}
          {...EXTERNAL}
          aria-label={`Licence${NEW_TAB}`}
          title="Licence"
          // A 24 px target around the 14 px icon.
          className="-my-1 inline-flex shrink-0 rounded-sm p-[5px] hover:text-text focus-visible:-outline-offset-1"
        >
          <ScrollText aria-hidden="true" className="size-3.5" />
        </a>
      )}
    </>
  )
}

/** The status of the app's "now playing" marker for the embed's current track. */
function markerStatus(view: EmbedView): NowPlayingStatus {
  if (view.status === 'error') return 'error'
  return isActive(view) ? 'playing' : 'paused'
}

/**
 * An album's or playlist's tracks; picking one plays it. The current track's row has the app's
 * "now playing" marker in place of its number, and says "Now playing", "Paused" or "Couldn’t
 * play".
 */
export function TrackList({
  view,
  actions,
}: {
  view: EmbedView
  actions: EmbedActions | undefined
}) {
  const status = markerStatus(view)
  return (
    <ol aria-label="Tracks" className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
      {view.rows.map((row, index) => {
        const current = index === view.currentIndex && view.status !== 'idle'
        return (
          <li key={row.key}>
            <button
              type="button"
              aria-current={current ? 'true' : undefined}
              aria-label={nowPlayingLabel(
                `Play ${row.title}${row.artists ? ` by ${row.artists}` : ''}`,
                current ? status : undefined,
              )}
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
                  current ? 'flex justify-end text-accent' : 'text-text-muted',
                )}
              >
                {current ? <NowPlayingBars status={status} /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-sm',
                    current ? 'font-semibold text-accent forced-colors:text-[Highlight]' : '',
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
