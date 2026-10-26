import { create } from 'zustand'

interface SoundDialogState {
  /** Whether the Sound dialog is open. */
  open: boolean
  openDialog: () => void
  close: () => void
}

/**
 * Whether the Sound dialog shows. The app layout renders the dialog once; the player bar, Now
 * playing and the track menus' "Equalizer" open it from anywhere.
 */
export const useSoundDialogStore = create<SoundDialogState>()((set) => ({
  open: false,
  openDialog: () => set({ open: true }),
  close: () => set({ open: false }),
}))
