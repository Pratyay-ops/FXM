/**
 * The search and catalog pages' "Equalizer" (the `EqualizerActions` seam of stage 2.4): it opens
 * the Sound dialog, whose equalizer applies to everything that plays.
 *
 * @module
 */

import { appActions, type EqualizerActions, type MediaActionsStore } from '../search/actions'
import { useSoundDialogStore } from './sound-dialog-store'

/** Opens the Sound dialog at its equalizer. */
export const equalizerActions: EqualizerActions = {
  open: () => useSoundDialogStore.getState().openDialog('equalizer'),
}

/** Adds "Equalizer" to the track menus: the catalog pages' actions get {@link equalizerActions}. */
export function wireEqualizerActions(store: MediaActionsStore = appActions): void {
  store.set({ ...store.get(), equalizer: equalizerActions })
}
