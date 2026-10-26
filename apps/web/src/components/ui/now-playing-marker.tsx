/**
 * The "now playing" marker of track lists: the row of the track the player is on shows
 * equalizer bars, which move while the track plays and stand still, low and even, while it is
 * paused or couldn't play. They take the place of the row's number, or sit over its artwork
 * where it has none. The marker is decorative: the row says the same in words
 * ({@link nowPlayingLabel}), marks itself with `aria-current="true"` and shows its title in the
 * accent colour.
 *
 * Presentational only, so the embed uses it too: the app's lists learn the status from
 * `useNowPlayingStatus` in `features/now-playing/current-track.ts`.
 *
 * @module
 */

import { cn } from '../../lib/cn'
import { useMediaQuery } from '../../lib/use-media-query'

/**
 * How the current track stands: `playing` while it plays or is about to (it loads), `error` once
 * playback stopped on a problem with it, `paused` otherwise (paused, ended, or put back after a
 * reload).
 */
export type NowPlayingStatus = 'playing' | 'paused' | 'error'

/** The marker's status in words; a problem as the queue and the player bar say it. */
const TEXTS: Record<NowPlayingStatus, string> = {
  playing: 'Now playing',
  paused: 'Paused',
  error: 'Couldn’t play',
}

/** What the marker shows, in words: "Now playing", "Paused" or "Couldn’t play". */
export function nowPlayingText(status: NowPlayingStatus): string {
  return TEXTS[status]
}

/**
 * The accessible name of a row's play control, `label`, with what the marker shows said in
 * words when the row is the current track's: "Play Copper Sun by Aurora Lane. Now playing".
 */
export function nowPlayingLabel(label: string, status: NowPlayingStatus | undefined): string {
  return status === undefined ? label : `${label}. ${nowPlayingText(status)}`
}

/**
 * The bars: where each stands, its height while the track plays and motion is reduced (a still
 * equalizer), and how it moves otherwise. The timings are classes, not inline styles, so the
 * app's reduced-motion rule (styles/index.css) still overrides them.
 */
const BARS = [
  { x: 1, height: 0.6, motion: '[animation-duration:0.9s] [animation-delay:-0.5s]' },
  { x: 5, height: 1, motion: '[animation-duration:1.1s] [animation-delay:-0.2s]' },
  { x: 9, height: 0.45, motion: '[animation-duration:0.8s] [animation-delay:-0.7s]' },
  { x: 13, height: 0.8, motion: '[animation-duration:1s] [animation-delay:-0.35s]' },
] as const

/**
 * How tall every bar stands while the track is paused or couldn't play: low and even, apart
 * from playing.
 */
const PAUSED_HEIGHT = 0.4

const SIZES = { sm: 'size-4', md: 'size-5', lg: 'size-8' } as const

const RADII = { sm: 'rounded-sm', md: 'rounded-md' } as const

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export interface NowPlayingBarsProps {
  status: NowPlayingStatus
  /** 16, 20 or 32 px. Default `sm`. */
  size?: keyof typeof SIZES | undefined
  /** Layout and colour classes: the bars are drawn in the current text colour. */
  className?: string | undefined
}

/**
 * The equalizer bars, in the current text colour (in forced colours, the system's text colour).
 * They move while the track plays, unless the user asked for reduced motion: then they stand
 * still at uneven heights, while the bars of a paused track, or of one that couldn't play,
 * stand low and even.
 */
export function NowPlayingBars({ status, size = 'sm', className }: NowPlayingBarsProps) {
  const reduceMotion = useMediaQuery(REDUCED_MOTION_QUERY)
  const moving = status === 'playing' && !reduceMotion
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      data-now-playing={status}
      data-moving={moving ? '' : undefined}
      className={cn(
        'shrink-0 fill-current forced-colors:fill-[CanvasText]',
        SIZES[size],
        className,
      )}
    >
      {BARS.map((bar) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={2}
          width={2}
          height={13}
          rx={1}
          className={cn(
            'origin-bottom [transform-box:fill-box]',
            moving && `animate-now-playing motion-reduce:animate-none ${bar.motion}`,
          )}
          style={{ transform: `scaleY(${status === 'playing' ? bar.height : PAUSED_HEIGHT})` }}
        />
      ))}
    </svg>
  )
}

export interface NowPlayingOverlayProps {
  status: NowPlayingStatus
  /** The bars' size. Default `md`. */
  size?: NowPlayingBarsProps['size']
  /** The corners of the artwork it covers. Default `sm`. */
  rounded?: keyof typeof RADII | undefined
  /** Visibility classes, e.g. `md:hidden` where the row's number shows the marker instead. */
  className?: string | undefined
}

/**
 * The marker over a row's artwork, for rows without a number: the bars, white on a scrim that
 * keeps them clear on any cover (at least 5.7:1 on a white one), on the system's background in
 * forced colours. Put it in the artwork's `relative` wrapper.
 */
export function NowPlayingOverlay({
  status,
  size = 'md',
  rounded = 'sm',
  className,
}: NowPlayingOverlayProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute inset-0 grid place-items-center bg-black/60 text-white forced-colors:bg-[Canvas]',
        RADII[rounded],
        className,
      )}
    >
      <NowPlayingBars status={status} size={size} />
    </span>
  )
}
