import { create } from 'zustand'

/** A part of the Sound dialog it can open at: the equalizer, for the track menus' "Equalizer". */
export type SoundSection = 'equalizer'

interface SoundDialogState {
  /** Whether the Sound dialog is open. */
  open: boolean
  /** The part it opened at, with its first control focused; at the top without one. */
  section: SoundSection | undefined
  openDialog: (section?: SoundSection) => void
  close: () => void
}

/**
 * Whether the Sound dialog shows. The app layout renders the dialog once; the player bar, Now
 * playing and the track menus' "Equalizer" open it from anywhere.
 */
export const useSoundDialogStore = create<SoundDialogState>()((set) => ({
  open: false,
  section: undefined,
  openDialog: (section) => set({ open: true, section }),
  close: () => set({ open: false, section: undefined }),
}))
