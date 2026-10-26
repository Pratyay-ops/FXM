import { PLAYBACK_RATE_PRESETS } from '@fxm/core'
import {
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { cn } from '../../lib/cn'
import { Dialog } from '../now-playing/dialog'
import { usePlayer } from '../now-playing/playback'
import { Switch } from '../queue/switch'
import { SOUND_SETTINGS_ID, useEffectsNotes } from './effects-section'
import { type SleepTimerSetting, useAudioEffectsStore } from './effects-store'
import { EqualizerDisclosure } from './equalizer-editor'
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

/** A minute count as a screen reader says it: "15 minutes", "1 hour", "1 hour 30 minutes". */
export function spokenMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const words = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`
  if (hours === 0) return words(rest, 'minute')
  return rest === 0 ? words(hours, 'hour') : `${words(hours, 'hour')} ${words(rest, 'minute')}`
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

/** What screen readers hear when the user changes the sleep timer, once per change. */
export function sleepAnnouncement(timer: SleepTimerSetting | undefined): string {
  if (timer === undefined) return 'Sleep timer off'
  if ('endOfTrack' in timer) return 'Sleep timer on: pauses after this track'
  return `Sleep timer on: pauses in ${spokenMinutes(timer.minutes)}`
}

/** One chip of a {@link ChipGroup}. */
interface Choice {
  /** Its key among the group's chips. */
  readonly key: string
  readonly label: string
}

/**
 * Chips of which one is picked: native radio buttons in a group named by `labelledBy`, so the
 * group is one tab stop, the arrow keys move to another chip and pick it, and screen readers say
 * which of how many is picked. Picking the chip that is picked calls `onPick` again (only a
 * click comes then, no `change`): a sleep timer starts over.
 */
function ChipGroup({
  labelledBy,
  choices,
  checked,
  onPick,
}: {
  labelledBy: string
  choices: readonly Choice[]
  checked: string | undefined
  onPick: (key: string) => void
}) {
  const name = useId()
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
      {choices.map((choice) => {
        const picked = choice.key === checked
        return (
          <label
            key={choice.key}
            className={cn(
              'inline-flex h-touch cursor-pointer items-center rounded-full border px-4 text-sm font-semibold transition-colors select-none has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus lg:h-9 lg:pointer-coarse:h-touch',
              // Forced colors (Windows High Contrast) drop the fill: mark the pick in system colors
              // (adjust-none, or the browser's text backplate hides the HighlightText label).
              picked
                ? 'border-accent bg-accent text-on-accent forced-colors:border-[Highlight] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:forced-color-adjust-none forced-colors:has-[:focus-visible]:outline-[CanvasText]'
                : 'border-border-strong bg-surface text-text hover:bg-text/8',
            )}
          >
            <input
              type="radio"
              name={name}
              value={choice.key}
              checked={picked}
              onChange={() => onPick(choice.key)}
              onClick={() => {
                if (picked) onPick(choice.key)
              }}
              className="sr-only"
            />
            {choice.label}
          </label>
        )
      })}
    </div>
  )
}

/**
 * One part of the dialog: a heading (`titleId`, which names its controls) and its controls. A
 * part whose switch names it (the equalizer, volume) needs no heading.
 */
function Part({
  title,
  titleId,
  ref,
  children,
}: {
  title?: string
  titleId?: string
  ref?: Ref<HTMLDivElement> | undefined
  children: ReactNode
}) {
  if (title === undefined) {
    return (
      <div ref={ref} className="space-y-3 py-4 first:pt-1">
        {children}
      </div>
    )
  }
  return (
    <section aria-labelledby={titleId} className="space-y-3 py-4 first:pt-1">
      <h3 id={titleId} className="font-semibold">
        {title}
      </h3>
      {children}
    </section>
  )
}

const SLEEP_CHOICES: readonly Choice[] = [
  { key: 'off', label: 'Off' },
  ...SLEEP_MINUTES.map((minutes) => ({ key: String(minutes), label: formatMinutes(minutes) })),
  { key: 'end', label: 'End of track' },
]

/** The sleep timer's chip for a setting. */
function sleepChoiceOf(timer: SleepTimerSetting | undefined): string {
  if (timer === undefined) return 'off'
  return 'endOfTrack' in timer ? 'end' : String(timer.minutes)
}

/** The sleep timer's choices and what the running one does. */
function SleepTimerPart() {
  const titleId = useId()
  const timer = useAudioEffectsStore((state) => state.sleepTimer)
  const [announcement, setAnnouncement] = useState('')
  const counting = timer !== undefined && !('endOfTrack' in timer)
  const now = useNow(counting)
  const pick = (key: string) => {
    const store = useAudioEffectsStore.getState()
    if (key === 'off') store.cancelSleepTimer()
    else if (key === 'end') store.sleepAtEndOfTrack()
    else store.sleepAfter(Number(key))
    setAnnouncement(sleepAnnouncement(useAudioEffectsStore.getState().sleepTimer))
  }
  return (
    <Part title="Sleep timer" titleId={titleId}>
      {/* A timer isn't read out as it counts down (its live region is off); a change is, below. */}
      <p role={counting ? 'timer' : undefined} className="text-sm text-text-muted">
        {sleepStatus(timer, now)}
      </p>
      <ChipGroup
        labelledBy={titleId}
        choices={SLEEP_CHOICES}
        checked={sleepChoiceOf(timer)}
        onPick={pick}
      />
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </Part>
  )
}

const SPEED_CHOICES: readonly Choice[] = QUICK_RATES.map((rate) => ({
  key: String(rate),
  label: formatRate(rate),
}))

/** Playback speed at a tap. */
function SpeedPart() {
  const titleId = useId()
  const rate = useAudioEffectsStore((state) => state.effects.playbackRate)
  const setRate = useAudioEffectsStore((state) => state.setPlaybackRate)
  const supported = usePlayer().effectsSupport().playbackRate
  if (!supported) return null
  return (
    <Part title={`Speed: ${formatRate(rate)}`} titleId={titleId}>
      <ChipGroup
        labelledBy={titleId}
        choices={SPEED_CHOICES}
        checked={String(rate)}
        onPick={(key) => setRate(Number(key))}
      />
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
 * The equalizer's switch, why it can't process the track that plays, and its bands behind
 * "Adjust the bands" (open when the dialog opened at the equalizer).
 */
function EqualizerPart({
  ref,
  openBands,
}: {
  ref?: Ref<HTMLDivElement> | undefined
  openBands: boolean
}) {
  const equalizer = useAudioEffectsStore((state) => state.effects.equalizer)
  const setEnabled = useAudioEffectsStore((state) => state.setEqualizerEnabled)
  const notes = useEffectsNotes()
  return (
    <Part ref={ref}>
      <Switch
        label="Equalizer"
        {...(equalizer.enabled && notes.equalizer !== undefined
          ? { description: notes.equalizer }
          : {})}
        checked={equalizer.enabled}
        onChange={setEnabled}
      />
      <EqualizerDisclosure defaultOpen={openBands} />
    </Part>
  )
}

/**
 * The Sound dialog: the sleep timer, speed, volume normalization and the equalizer, from the
 * player bar, Now playing and the track menus ("Equalizer", which opens it at the equalizer).
 * The app layout renders it once; anything opens it through {@link useSoundDialogStore}.
 */
export function SoundDialog() {
  const wanted = useSoundDialogStore((state) => state.open)
  const section = useSoundDialogStore((state) => state.section)
  const close = useSoundDialogStore((state) => state.close)
  // The host mounts this when the dialog should open. `Dialog` mounts closed and opens on the next
  // render, as the app's other dialogs do: one mounted open and then remounted (React's StrictMode
  // does that in development) would close itself, and its `close` event would close the dialog.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const open = wanted && mounted
  const equalizer = useRef<HTMLDivElement>(null)
  // After the dialog's own focus (`showModal()`, in the layout effect of `Dialog`, a child): when
  // it opened at the equalizer, the equalizer's part shows at the top, its switch focused.
  useLayoutEffect(() => {
    const part = equalizer.current
    if (!open || section !== 'equalizer' || part === null) return
    part.scrollIntoView({ block: 'start' })
    part.querySelector<HTMLElement>('[role="switch"]')?.focus({ preventScroll: true })
  }, [open, section])
  return (
    <Dialog
      open={open}
      title="Sound"
      description="Sleep timer, speed, volume and equalizer."
      onClose={close}
      footer={
        <Link
          to={`/settings#${SOUND_SETTINGS_ID}`}
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
        <LoudnessPart />
        <EqualizerPart ref={equalizer} openBands={section === 'equalizer'} />
      </div>
    </Dialog>
  )
}
