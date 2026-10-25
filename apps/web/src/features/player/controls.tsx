import { formatTime } from '@fxm/player'
import {
  Heart,
  LoaderCircle,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useState } from 'react'
import { IconButton, type IconButtonSize } from '../../components/ui/icon-button'
import { RangeSlider } from '../../components/ui/range-slider'
import { cn } from '../../lib/cn'
import { type RepeatMode, usePlayerStore } from './player-store'

const REPEAT_LABELS: Readonly<Record<RepeatMode, string>> = {
  off: 'Enable repeat',
  all: 'Enable repeat one',
  one: 'Disable repeat',
}

const PLAY_BUTTON_STYLES = {
  /** Desktop and tablet player bar. */
  bar: {
    variant: 'contrast',
    className: 'size-touch lg:size-9 lg:pointer-coarse:size-touch [&_svg]:size-5 lg:[&_svg]:size-4',
  },
  /** Phone mini player: a bare icon, like the other mini player buttons. */
  mini: { variant: 'plain', className: 'size-touch [&_svg]:size-6' },
  /** Phone now-playing screen. */
  hero: { variant: 'contrast', className: 'size-16 [&_svg]:size-7' },
  /** Big call-to-action on album, artist and playlist pages. */
  cta: { variant: 'accent', className: 'size-14 [&_svg]:size-6' },
} as const

type PlayButtonAppearance = keyof typeof PLAY_BUTTON_STYLES

/**
 * The big play button of the album, artist and playlist placeholder pages. It responds but
 * plays nothing, like the shell's other placeholders, rather than pausing whatever the queue
 * plays: playing a collection arrives with the search and browse pages (stage 2.4).
 */
function CollectionPlayButton() {
  const [playing, setPlaying] = useState(false)
  const Icon = playing ? Pause : Play
  const style = PLAY_BUTTON_STYLES.cta
  return (
    <IconButton
      label={playing ? 'Pause' : 'Play'}
      icon={<Icon fill="currentColor" strokeWidth={0} className={cn(!playing && 'ml-0.5')} />}
      size="custom"
      variant={style.variant}
      className={style.className}
      onClick={() => setPlaying(!playing)}
    />
  )
}

/** Play/pause for the app's player; `cta` is the collection pages' placeholder for now. */
export function PlayPauseButton({ appearance = 'bar' }: { appearance?: PlayButtonAppearance }) {
  return appearance === 'cta' ? (
    <CollectionPlayButton />
  ) : (
    <PlayerPlayPauseButton appearance={appearance} />
  )
}

function PlayerPlayPauseButton({ appearance }: { appearance: PlayButtonAppearance }) {
  const hasTrack = usePlayerStore((state) => state.hasTrack)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const busy = usePlayerStore((state) => state.busy)
  const togglePlay = usePlayerStore((state) => state.togglePlay)
  const Icon = isPlaying ? Pause : Play
  const style = PLAY_BUTTON_STYLES[appearance]
  return (
    <IconButton
      label={isPlaying ? 'Pause' : 'Play'}
      icon={
        isPlaying && busy ? (
          // Waiting for the stream: pressing it still pauses.
          <LoaderCircle className="animate-spin" />
        ) : (
          // The play triangle's visual center sits left of its box: nudge it right.
          <Icon fill="currentColor" strokeWidth={0} className={cn(!isPlaying && 'ml-0.5')} />
        )
      }
      size="custom"
      variant={style.variant}
      className={style.className}
      disabled={!hasTrack}
      onClick={togglePlay}
    />
  )
}

/** Shuffle, previous, play/pause, next and repeat. */
export function PlayerControls({
  size = 'md',
  className,
}: {
  /** `lg` is the big set on the phone's now-playing screen. */
  size?: 'md' | 'lg'
  className?: string
}) {
  const hasTrack = usePlayerStore((state) => state.hasTrack)
  const shuffle = usePlayerStore((state) => state.shuffle)
  const repeat = usePlayerStore((state) => state.repeat)
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle)
  const cycleRepeat = usePlayerStore((state) => state.cycleRepeat)
  const previous = usePlayerStore((state) => state.previous)
  const next = usePlayerStore((state) => state.next)
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat
  const skipSize: IconButtonSize = size === 'lg' ? 'lg' : 'sm'

  return (
    <div
      className={cn(
        'flex items-center',
        size === 'lg' ? 'justify-between' : 'justify-center gap-1 lg:gap-2',
        className,
      )}
    >
      <IconButton
        label="Shuffle"
        icon={<Shuffle />}
        size="sm"
        pressed={shuffle}
        dot
        onClick={toggleShuffle}
      />
      <IconButton
        label="Previous"
        icon={<SkipBack fill="currentColor" />}
        size={skipSize}
        variant="plain"
        disabled={!hasTrack}
        onClick={previous}
      />
      <PlayPauseButton appearance={size === 'lg' ? 'hero' : 'bar'} />
      <IconButton
        label="Next"
        icon={<SkipForward fill="currentColor" />}
        size={skipSize}
        variant="plain"
        disabled={!hasTrack}
        onClick={next}
      />
      <IconButton
        label={REPEAT_LABELS[repeat]}
        icon={<RepeatIcon />}
        size="sm"
        active={repeat !== 'off'}
        dot
        onClick={cycleRepeat}
      />
    </div>
  )
}

/**
 * Elapsed time, seek slider and duration, with times formatted by @fxm/player. While the thumb
 * is dragged, the slider shows where it is and seeks only when it is let go (or on each key
 * press): every seek may start a new request for the stream.
 */
export function SeekBar({ className }: { className?: string }) {
  const hasTrack = usePlayerStore((state) => state.hasTrack)
  const position = usePlayerStore((state) => state.position)
  const duration = usePlayerStore((state) => state.duration)
  const seek = usePlayerStore((state) => state.seek)
  const [dragged, setDragged] = useState<number | null>(null)
  const shown = dragged ?? position
  return (
    <div className={cn('flex w-full items-center gap-2 text-xs text-text-muted', className)}>
      <span className="min-w-10 text-right tabular-nums">{formatTime(shown)}</span>
      <RangeSlider
        label="Seek"
        min={0}
        max={duration}
        value={shown}
        valueText={`${formatTime(shown)} of ${formatTime(duration)}`}
        onValueChange={setDragged}
        onValueCommit={(seconds) => {
          setDragged(null)
          seek(seconds)
        }}
        // Let go where it started: no change event follows, so stop showing the drag.
        onPointerUp={() => setTimeout(() => setDragged(null))}
        onBlur={() => setDragged(null)}
        disabled={!hasTrack}
        className="min-w-0 flex-1"
      />
      <span className="min-w-10 tabular-nums">{formatTime(duration)}</span>
    </div>
  )
}

/** Likes the current track (a placeholder until the library, stage 2.6); off while none. */
export function LikeButton({ size = 'sm' }: { size?: IconButtonSize }) {
  const hasTrack = usePlayerStore((state) => state.hasTrack)
  const liked = usePlayerStore((state) => state.liked)
  const toggleLiked = usePlayerStore((state) => state.toggleLiked)
  return (
    <IconButton
      label="Like"
      icon={<Heart fill={liked ? 'currentColor' : 'none'} />}
      size={size}
      pressed={liked}
      disabled={!hasTrack}
      onClick={toggleLiked}
    />
  )
}

/** Mute toggle plus a volume slider (the slider appears from 1024px). */
export function VolumeControl() {
  const volume = usePlayerStore((state) => state.volume)
  const muted = usePlayerStore((state) => state.muted)
  const setVolume = usePlayerStore((state) => state.setVolume)
  const toggleMute = usePlayerStore((state) => state.toggleMute)
  const percent = muted ? 0 : Math.round(volume * 100)
  const Icon = percent === 0 ? VolumeX : percent < 50 ? Volume1 : Volume2
  return (
    <div className="flex items-center gap-1">
      <IconButton
        label={percent === 0 ? 'Unmute' : 'Mute'}
        icon={<Icon />}
        size="sm"
        onClick={toggleMute}
      />
      <RangeSlider
        label="Volume"
        min={0}
        max={100}
        value={percent}
        valueText={`${percent}%`}
        onValueChange={(value) => setVolume(value / 100)}
        className="hidden w-24 lg:block xl:w-28"
      />
    </div>
  )
}
