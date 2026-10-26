/**
 * The one-way, three-way merge of a copied list: what changed on Spotify since the last sync
 * (the **base**, what Spotify held then) is brought into the library's copy, and what the user
 * changed in the copy stays. Pure functions over IDs.
 *
 * - A track Spotify added since the last sync is added, unless the copy has it already. It goes
 *   right after the track Spotify has before it, or first when Spotify has it first, so the
 *   user's own order of everything else stays as it is.
 * - A track Spotify removed since the last sync is taken out of the copy.
 * - A track the user removed from the copy stays out while Spotify keeps it; one the user added
 *   stays in. Nothing is ever written to Spotify.
 * - A name or description Spotify changed replaces the copy's, unless the user changed it too.
 *
 * @module
 */

/** What to do to a copy so that it follows Spotify's changes since the last sync. */
export interface ListChanges {
  /** Tracks to add: new on Spotify since the last sync, and not in the copy. In Spotify's order. */
  readonly added: string[]
  /** Tracks to take out: gone from Spotify since the last sync, and still in the copy. */
  readonly removed: string[]
}

/**
 * The changes that bring Spotify's changes since `base` into `local`.
 *
 * @param base What Spotify held at the last sync, in its order.
 * @param remote What Spotify holds now, in its order.
 * @param local What the copy holds now.
 */
export function listChanges(
  base: readonly string[],
  remote: readonly string[],
  local: readonly string[],
): ListChanges {
  const before = new Set(base)
  const now = new Set(remote)
  const here = new Set(local)
  const added: string[] = []
  for (const id of now) if (!before.has(id) && !here.has(id)) added.push(id)
  const removed = [...before].filter((id) => !now.has(id) && here.has(id))
  return { added, removed }
}

/**
 * The base of a copy the sync finds without a record of its own: one that came back from a
 * backup, from another device, or from another account's sync. Only what both hold counts as
 * synced, so the first sync adds what Spotify has and the copy lacks, and removes nothing: what
 * the copy has beyond Spotify may be the user's own.
 */
export function adoptedBase(remote: readonly string[], local: readonly string[]): string[] {
  const here = new Set(local)
  return remote.filter((id) => here.has(id))
}

/**
 * `local` with the tracks of `added` placed as Spotify has them: each right after the nearest
 * track before it in `remote` that `local` holds (after the other new tracks Spotify put there,
 * in Spotify's order), or first when `remote` has none before it. Everything else keeps its
 * place. Linear in the lengths.
 */
export function placeNewTracks(
  local: readonly string[],
  remote: readonly string[],
  added: ReadonlySet<string>,
): string[] {
  const kept = local.filter((id) => !added.has(id))
  const present = new Set(kept)
  const first: string[] = []
  const after = new Map<string, string[]>()
  let anchor: string | undefined
  for (const id of remote) {
    if (added.has(id)) {
      if (anchor === undefined) first.push(id)
      else {
        const group = after.get(anchor)
        if (group) group.push(id)
        else after.set(anchor, [id])
      }
    } else if (present.has(id)) {
      anchor = id
    }
  }
  const placed = [...first]
  for (const id of kept) {
    placed.push(id)
    const group = after.get(id)
    if (group) placed.push(...group)
  }
  return placed
}

/**
 * A field of the copy after a sync: Spotify's new value when Spotify changed it since the last
 * sync and the user didn't, else the copy's own. Without a base (an adopted copy), the copy's.
 */
export function mergedField<T>(base: T | undefined, remote: T, local: T, adopted: boolean): T {
  if (adopted) return local
  return remote !== base && local === base ? remote : local
}
