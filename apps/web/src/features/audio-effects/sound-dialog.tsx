import { PLAYBACK_RATE_PRESETS } from '@fxm/core'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { cn } from '../../lib/cn'
import { Dialog } from '../now-playing/dialog'
import { usePlayer } from '../now-playing/playback'
import { Switch } from '../queue/switch'
import { useEffectsNotes } from './effects-section'
import { type SleepTimerSetting, useAudioEffectsStore } from './effects-store'
import { EqualizerEditor } from './equalizer-editor'
import { useSoundDialogStore } from './sound-dialog-store'
import { formatRate, formatRemaining } from './status'

/** The sleep timer's choices, in minutes. */
export const SLEEP_MINUTES: readonly number[] = Object.freeze([15, 30, 45, 60, 90])

/** The speeds the dialog offers at a tap. */
const QUICK_RATES = PLAYBACK_RATE_PRESETS.filter((rate) => [0.75, 1, 1.25, 1.5, 2].includes(rate))

/** A minute count as people read it: "15 min", "1 h", "1 h 30 min". */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** The time now, ticking every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** How a running sleep timer reads: "Pauses in 12:04", "Pauses after this track". */
export function sleepStatus(timer: SleepTimerSetting | undefined, now: number): string {
  if (timer === undefined) return 'Off'
  if ('endOfTrack' in timer) return 'Pauses after this track'
  return `Pauses in ${formatRemaining(timer.endsAt - now)}`
}

/** A choice chip: a toggle button that shows when it is the one picked. */
function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-touch items-center rounded-full border px-4 text-sm font-semibold transition-colors lg:h-9 lg:pointer-coarse:h-touch',
        pressed
          ? 'border-accent bg-accent text-on-accent'
          : 'border-border bg-surface text-text hover:border-border-strong',
      )}
    >
      {children}
    </button>
  )
}

/**
 * One part of the dialog: a heading and its controls. A part whose switch names it (the
 * equalizer, volume) needs no heading.
 */
function Part({ title, children }: { title?: string; children: ReactNode }) {
  const headingId = useId()
  if (title === undefined) return <div className="space-y-3 py-4 first:pt-1">{children}</div>
  return (
    <section aria-labelledby={headingId} className="space-y-3 py-4 first:pt-1">
      <h3 id={headingId} className="font-semibold">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** The sleep timer's choices and what the running one does. */
function SleepTimerPart() {
  const timer = useAudioEffectsStore((state) => state.sleepTimer)
  const sleepAfter = useAudioEffectsStore((state) => state.sleepAfter)
  const sleepAtEnd = useAudioEffectsStore((state) => state.sleepAtEndOfTrack)
  const cancel = useAudioEffectsStore((state) => state.cancelSleepTimer)
  const now = useNow(timer !== undefined && !('endOfTrack' in timer))
  const minutes = timer !== undefined && 'minutes' in timer ? timer.minutes : undefined
  return (
    <Part title="Sleep timer">
      <p className="text-sm text-text-muted" aria-live="polite">
        {sleepStatus(timer, now)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Chip pressed={timer === undefined} onClick={cancel}>
          Off
        </Chip>
        {SLEEP_MINUTES.map((option) => (
          <Chip key={option} pressed={minutes === option} onClick={() => sleepAfter(option)}>
            {formatMinutes(option)}
          </Chip>
        ))}
        <Chip pressed={timer !== undefined && 'endOfTrack' in timer} onClick={sleepAtEnd}>
          End of track
        </Chip>
      </div>
    </Part>
  )
}

/** Playback speed at a tap. */
function SpeedPart() {
  const rate = useAudioEffectsStore((state) => state.effects.playbackRate)
  const setRate = useAudioEffectsStore((state) => state.setPlaybackRate)
  const supported = usePlayer().effectsSupport().playbackRate
  if (!supported) return null
  return (
    <Part title={`Speed: ${formatRate(rate)}`}>
      <div className="flex flex-wrap gap-2">
        {QUICK_RATES.map((option) => (
          <Chip key={option} pressed={rate === option} onClick={() => setRate(option)}>
            {formatRate(option)}
          </Chip>
        ))}
      </div>
    </Part>
  )
}

/** The equalizer's switch, its bands, and why it can't process the track that plays. */
function EqualizerPart() {
  const equalizer = useAudioEffectsStore((state) => state.effects.equalizer)
  const setEnabled = useAudioEffectsStore((state) => state.setEqualizerEnabled)
  const notes = useEffectsNotes()
  return (
    <Part>
      <Switch
        label="Equalizer"
        {...(equalizer.enabled && notes.equalizer !== undefined
          ? { description: notes.equalizer }
          : {})}
        checked={equalizer.enabled}
        onChange={setEnabled}
      />
      <EqualizerEditor />
    </Part>
  )
}

/** Loudness normalization's switch and what it does to the track that plays. */
function LoudnessPart() {
  const enabled = useAudioEffectsStore((state) => state.effects.loudness.enabled)
  const setLoudness = useAudioEffectsStore((state) => state.setLoudness)
  const notes = useEffectsNotes()
  return (
    <Part>
      <Switch
        label="Normalize volume"
        description={
          enabled && notes.loudness !== undefined
            ? notes.loudness
            : 'Plays every track at about the same loudness.'
        }
        checked={enabled}
        onChange={(on) => setLoudness({ enabled: on })}
      />
    </Part>
  )
}

/**
 * The Sound dialog: the sleep timer, speed, equalizer and volume normalization, from the player
 * bar, Now playing and the track menus ("Equalizer"). The app layout renders it once; anything
 * opens it through {@link useSoundDialogStore}.
 */
export function SoundDialog() {
  const open = useSoundDialogStore((state) => state.open)
  const close = useSoundDialogStore((state) => state.close)
  return (
    <Dialog
      open={open}
      title="Sound"
      description="Sleep timer, speed, equalizer and volume."
      onClose={close}
      footer={
        <Link
          to="/settings#sound"
          onClick={close}
          className={buttonClasses({ variant: 'secondary', className: 'h-10 px-4' })}
        >
          More in Settings
        </Link>
      }
    >
      <div className="divide-y divide-border">
        <SleepTimerPart />
        <SpeedPart />
        <EqualizerPart />
        <LoudnessPart />
      </div>
    </Dialog>
  )
}
