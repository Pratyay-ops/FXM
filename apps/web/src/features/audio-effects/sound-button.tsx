import { Moon, SlidersHorizontal } from 'lucide-react'
import { buttonClasses } from '../../components/ui/button'
import { IconButton } from '../../components/ui/icon-button'
import { cn } from '../../lib/cn'
import { useAudioEffectsStore } from './effects-store'
import { useSoundDialogStore } from './sound-dialog-store'
import { formatRate } from './status'

/** Whether something in the Sound dialog differs from normal: a timer, a speed, the equalizer. */
function useSoundChanged(): boolean {
  const timer = useAudioEffectsStore((state) => state.sleepTimer)
  const rate = useAudioEffectsStore((state) => state.effects.playbackRate)
  const equalizer = useAudioEffectsStore((state) => state.effects.equalizer.enabled)
  return timer !== undefined || rate !== 1 || equalizer
}

/**
 * Opens the Sound dialog: an icon button in the player bar, highlighted while a sleep timer
 * runs, the speed isn't normal or the equalizer is on; the speed shows beside it then.
 */
export function SoundButton() {
  const openDialog = useSoundDialogStore((state) => state.openDialog)
  const changed = useSoundChanged()
  const rate = useAudioEffectsStore((state) => state.effects.playbackRate)
  const timer = useAudioEffectsStore((state) => state.sleepTimer)
  return (
    <div className="flex items-center">
      {rate !== 1 && (
        <span className="text-xs font-semibold text-accent tabular-nums">{formatRate(rate)}</span>
      )}
      <IconButton
        label={timer === undefined ? 'Sound' : 'Sound (sleep timer on)'}
        icon={timer === undefined ? <SlidersHorizontal /> : <Moon />}
        size="sm"
        active={changed}
        dot
        onClick={() => openDialog()}
      />
    </div>
  )
}

/**
 * Now playing's "Sound" shortcut on phones, between "Lyrics" and "Queue". Below 360 px only its
 * icon shows (the name stays for screen readers), so the three fit a 320 px screen.
 */
export function SoundShortcut({ className }: { className?: string }) {
  const openDialog = useSoundDialogStore((state) => state.openDialog)
  const timer = useAudioEffectsStore((state) => state.sleepTimer)
  const Icon = timer === undefined ? SlidersHorizontal : Moon
  return (
    <button
      type="button"
      className={buttonClasses({
        variant: 'ghost',
        className: cn('min-w-touch px-3 max-[359px]:px-0', className),
      })}
      onClick={() => openDialog()}
    >
      <Icon aria-hidden="true" />
      <span className="max-[359px]:sr-only">Sound</span>
    </button>
  )
}
