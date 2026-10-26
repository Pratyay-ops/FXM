/**
 * A check of the listening affinity (stage 3.1) for sync tests. Tests only.
 *
 * @module
 */

import { affinityAt } from '@fxm/core'
import { expect } from 'vitest'
import type { testRepo } from '../../../test/library-fixtures'

/**
 * Checks that the affinity `repo` holds is what a rebuild from its library gives: the same
 * entries, with the same affinity, skips and plays. Sync writes the library past the
 * repository's upkeep of the affinity, so it must leave it as a rebuild would. Returns how many
 * entries it holds.
 */
export async function expectAffinityOfLibrary(repo: ReturnType<typeof testRepo>): Promise<number> {
  const held = await repo.db.affinity.toArray()
  await repo.rebuildAffinity()
  const rebuilt = new Map((await repo.db.affinity.toArray()).map((record) => [record.id, record]))
  expect(held.map((record) => record.id).sort()).toEqual([...rebuilt.keys()].sort())
  const now = repo.now()
  for (const record of held) {
    const other = rebuilt.get(record.id)
    if (other === undefined) continue
    const mine = affinityAt(record, now)
    const theirs = affinityAt(other, now)
    expect(mine.score, record.id).toBeCloseTo(theirs.score, 9)
    expect(mine.skips, record.id).toBeCloseTo(theirs.skips, 9)
    expect(record.plays, record.id).toBe(other.plays)
  }
  return held.length
}
