/**
 * The tidy-up after a Disconnect: what the sync keeps in the library's settings (its state, the
 * personal home and the state of each copy) exists only while the account is connected. A
 * Disconnect forgets it, but something can bring it back:
 *
 * - a tab that kept syncing after a Disconnect in another tab, because the browser froze it in
 *   the background, writes on once it wakes, until it learns of the Disconnect;
 * - a library backup made while the account was connected brings the rows back with it.
 *
 * So when the app starts without the account connected, it forgets them, in the background and
 * only while no tab syncs. The copies stay in the library, as ordinary playlists.
 *
 * @module
 */

import { type AccountChoiceStore, storedOptIn } from './account-store'
import { STATE_PREFIX } from './ids'
import { type LockManagerLike, SYNC_LOCK } from './locks'
import { forgetState, type StateStore } from './state'

/** Options for {@link tidyAfterDisconnect}. */
export interface TidyOptions {
  /** The library. */
  readonly library: StateStore
  /** The user's choice; what storage holds of it now counts too. */
  readonly choice: AccountChoiceStore
  /** Web Locks; without them it tidies at once. */
  readonly locks?: LockManagerLike | undefined
}

/**
 * Forgets what the sync left in the library while the account isn't connected. Does nothing
 * while a tab syncs (it holds the sync's lock), or when the choice says the account is connected,
 * in this tab or, as stored, in another. Resolves to whether it removed anything.
 */
export async function tidyAfterDisconnect({
  library,
  choice,
  locks,
}: TidyOptions): Promise<boolean> {
  // Another tab may have connected the account since this one read the choice.
  const connected = async () => choice.getState().optedIn || (await storedOptIn(choice))
  const tidy = async () => {
    if (await connected()) return false
    const rows = await library.getSettings(STATE_PREFIX)
    if (rows.size === 0 || (await connected())) return false
    await forgetState(library)
    return true
  }
  if (locks === undefined) return tidy()
  return locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) =>
    lock === null ? false : tidy(),
  )
}
