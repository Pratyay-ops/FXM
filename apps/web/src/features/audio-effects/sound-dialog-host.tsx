import { lazy, Suspense } from 'react'
import { useSoundDialogStore } from './sound-dialog-store'

// The dialog, its equalizer and the effects' words load the first time it opens, not with the app.
const SoundDialog = lazy(() =>
  import('./sound-dialog').then((module) => ({ default: module.SoundDialog })),
)

/** Renders the Sound dialog while it is open, loading it on first use. */
export function SoundDialogHost() {
  const open = useSoundDialogStore((state) => state.open)
  if (!open) return null
  return (
    <Suspense fallback={null}>
      <SoundDialog />
    </Suspense>
  )
}
