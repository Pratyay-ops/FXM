import { Moon, SlidersHorizontal } from 'lucide-react'
import { buttonClasses } from '../../components/ui/button'
import { IconButton } from '../../components/ui/icon-button'
import { cn } from '../../lib/cn'
import { useAudioEffectsStore } from './effects-store'
import { useSoundDialogStore } from './sound-dialog-store'
import { formatRate, type SoundChanges, soundLabel } from './status'

/** What differs from normal in the Sound dialog: a speed, the equalizer, a sleep timer. */
function useSoundChanges(): SoundChanges & { readonly changed: boolean } {
  const rate = useAudioEffectsStore((state) => state.effects.playbackRate)
  const equalizer = useAudioEffectsStore((state) => state.effects.equalizer.enabled)
  const sleepTimer = useAudioEffectsStore((state) => state.sleepTimer !== undefined)
  return { rate, equalizer, sleepTimer, changed: rate !== 1 || equalizer || sleepTimer }
}

/**
 * Opens the Sound dialog: an icon button in the player bar, a moon while a sleep timer runs,
 * highlighted (with a dot) while something differs from normal, which its name says too; the
 * speed shows beside it while it isn't 1×.
 */
export function SoundButton() {
  const openDialog = useSoundDialogStore((state) => state.openDialog)
  const changes = useSoundChanges()
  return (
    <div className="flex items-center gap-1.5">
      {changes.rate !== 1 && (
        // The button's name says it: this is for the eye.
        <span aria-hidden="true" className="text-xs font-semibold text-accent tabular-nums">
          {formatRate(changes.rate)}
        </span>
      )}
      <IconButton
        label={soundLabel(changes)}
        icon={changes.sleepTimer ? <Moon /> : <SlidersHorizontal />}
        size="sm"
        active={changes.changed}
        dot
        onClick={() => openDialog()}
      />
    </div>
  )
}

/**
 * Now playing's "Sound" shortcut on phones, between "Lyrics" and "Queue": highlighted with a dot
 * while something differs from normal, which its name says too, and showing the speed in place of
 * its label while it isn't 1×. Below 360 px only its icon (and the speed) shows, so the three fit
 * a 320 px screen.
 */
export function SoundShortcut({ className }: { className?: string }) {
  const openDialog = useSoundDialogStore((state) => state.openDialog)
  const changes = useSoundChanges()
  const Icon = changes.sleepTimer ? Moon : SlidersHorizontal
  return (
    <button
      type="button"
      aria-label={soundLabel(changes)}
      className={buttonClasses({
        variant: 'ghost',
        className: cn(
          'relative min-w-touch px-3',
          changes.rate === 1 ? 'max-[359px]:px-0' : 'max-[359px]:px-2',
          // `!`: over the ghost variant's own colours (`cn` doesn't merge classes).
          changes.changed &&
            'text-accent! after:absolute after:bottom-0.5 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-accent hover:text-accent!',
          className,
        ),
      })}
      onClick={() => openDialog()}
    >
      <Icon aria-hidden="true" />
      {changes.rate === 1 ? (
        <span className="max-[359px]:sr-only">Sound</span>
      ) : (
        <span className="tabular-nums">{formatRate(changes.rate)}</span>
      )}
    </button>
  )
}
