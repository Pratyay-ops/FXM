import { describe, expect, it } from 'vitest'
import { testRepo, track } from '../test/library-fixtures'

describe('refreshTracks', () => {
  it('updates the tracks the library holds, and only those', async () => {
    const repo = testRepo()
    await repo.like(track(1))
    const renamed = track(1, { title: 'Song 1 (Remastered)' })
    expect(await repo.refreshTracks([renamed, track(2)])).toBe(1)
    expect((await repo.getTrack(renamed.id))?.title).toBe('Song 1 (Remastered)')
    expect(await repo.getTrack(track(2).id)).toBeUndefined()
  })

  it('leaves unchanged tracks alone', async () => {
    const repo = testRepo()
    await repo.saveTracks([track(1)])
    const before = await repo.db.tracks.get(track(1).id)
    expect(await repo.refreshTracks([track(1)])).toBe(0)
    expect(await repo.db.tracks.get(track(1).id)).toEqual(before)
    expect(await repo.refreshTracks([])).toBe(0)
  })
})
