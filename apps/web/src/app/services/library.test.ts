import {
  type AudioCandidate,
  type CatalogMode,
  type EntityId,
  formatId,
  type Track,
} from '@fxm/core'
import type { MatchKey, StoredMatch } from '@fxm/player'
import { describe, expect, it, vi } from 'vitest'
import {
  type LibraryMatchDecision,
  type LibraryPlaylistSummary,
  type LibraryRepository,
  libraryActionsFrom,
  matchStoreFrom,
} from './library'

const TRACK: Track = {
  id: formatId('ytm', 'track', 'zFYEYRcjK2g'),
  source: 'ytm',
  title: 'Creep',
  artists: [{ name: 'Radiohead' }],
  artwork: [],
  kind: 'song',
}

const SOURCE = formatId('spotify', 'track', '70LcF31zb1H0PyJoS1Sx1r')

const CANDIDATE: AudioCandidate = {
  source: 'ytm',
  ref: 'zFYEYRcjK2g',
  kind: 'song',
  title: 'Creep',
  artists: ['Radiohead'],
  confidence: 0.93,
  evidence: ['title 1.00'],
}

const playlist = (id: string, extra: Partial<LibraryPlaylistSummary> = {}) =>
  ({
    id: formatId('local', 'playlist', id),
    origin: 'local',
    name: id,
    ...extra,
  }) satisfies LibraryPlaylistSummary

/** A library like stage 2.6's repository, as far as the seams use it. */
function fakeLibrary(): LibraryRepository & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>()
  const key = (id: EntityId<'track'>, mode: CatalogMode) => `${id}|${mode}`
  return {
    records,
    getPlaylistList: vi.fn(async () => ({
      items: [
        playlist('liked', { system: 'liked', name: 'Liked songs', trackCount: 3 }),
        playlist('downloads', { system: 'downloads', name: 'Downloads' }),
        playlist('road-trip', { trackCount: 12 }),
        { ...playlist('theirs'), origin: 'followed' as const },
      ],
    })),
    addTracks: vi.fn(async () => ({ added: 1, skipped: 0 })),
    createPlaylist: vi.fn(async () => formatId('local', 'playlist', 'new')),
    getMatch: vi.fn(async (id, mode) => records.get(key(id, mode))),
    recordMatch: vi.fn(async (decision: LibraryMatchDecision) => {
      records.set(key(decision.sourceTrackId, decision.mode), {
        ...decision,
        alternatives: decision.alternatives ?? [],
        evidence: decision.evidence ?? [],
        userPinned: false,
        decidedAt: 1,
      })
      return true
    }),
    pinMatch: vi.fn(async (id, mode, candidate) => {
      records.set(key(id, mode), {
        band: 'none',
        candidate,
        alternatives: [],
        evidence: ['pinned by the user'],
        userPinned: true,
        decidedAt: 2,
      })
    }),
    unpinMatch: vi.fn(async (id, mode) => {
      records.delete(key(id, mode))
    }),
    forgetMatch: vi.fn(async (id, mode) => records.delete(key(id, mode))),
  }
}

describe('libraryActionsFrom', () => {
  it("lists the library's own playlists, Liked songs included, Downloads not", async () => {
    const actions = libraryActionsFrom(fakeLibrary())

    await expect(actions.playlists()).resolves.toEqual([
      { id: 'local:playlist:liked', name: 'Liked songs', trackCount: 3 },
      { id: 'local:playlist:road-trip', name: 'road-trip', trackCount: 12 },
    ])
  })

  it('adds tracks to a playlist, and creates one with them', async () => {
    const library = fakeLibrary()
    const actions = libraryActionsFrom(library)

    await actions.addToPlaylist('local:playlist:road-trip', [TRACK])
    const created = await actions.createPlaylist('Night drive', [TRACK])

    expect(library.addTracks).toHaveBeenCalledWith('local:playlist:road-trip', [TRACK])
    expect(library.createPlaylist).toHaveBeenCalledWith({ name: 'Night drive', tracks: [TRACK] })
    expect(created).toEqual({ id: 'local:playlist:new', name: 'Night drive', trackCount: 1 })
  })

  it('refuses an ID that is not a playlist', async () => {
    const library = fakeLibrary()

    await expect(libraryActionsFrom(library).addToPlaylist('liked', [TRACK])).rejects.toThrow(
      RangeError,
    )
    expect(library.addTracks).not.toHaveBeenCalled()
  })
})

describe('matchStoreFrom', () => {
  const song: MatchKey = { sourceTrackId: SOURCE, mode: 'music', target: 'song' }
  const decision: StoredMatch = {
    band: 'suggest',
    candidate: CANDIDATE,
    alternatives: [],
    evidence: ['title 1.00'],
    userPinned: false,
    decidedAt: 5,
  }

  it("files the engine's song decisions in the library's match cache", async () => {
    const library = fakeLibrary()
    const store = matchStoreFrom(library)

    await store.put(song, decision)

    expect(library.recordMatch).toHaveBeenCalledWith({
      sourceTrackId: SOURCE,
      mode: 'music',
      band: 'suggest',
      candidate: CANDIDATE,
      alternatives: [],
      evidence: ['title 1.00'],
    })
    await expect(store.get(song)).resolves.toMatchObject({ band: 'suggest', userPinned: false })
  })

  it('files a pin as a pin, and removes it only as one', async () => {
    const library = fakeLibrary()
    const store = matchStoreFrom(library)

    await store.put(song, { ...decision, userPinned: true })
    await expect(store.get(song)).resolves.toMatchObject({ userPinned: true })
    await store.delete(song)

    expect(library.pinMatch).toHaveBeenCalledWith(SOURCE, 'music', CANDIDATE)
    expect(library.unpinMatch).toHaveBeenCalledWith(SOURCE, 'music')
    expect(library.forgetMatch).not.toHaveBeenCalled()
  })

  it("forgets an engine decision without touching the user's pins", async () => {
    const library = fakeLibrary()
    const store = matchStoreFrom(library)
    await store.put(song, decision)

    await store.delete(song)

    expect(library.forgetMatch).toHaveBeenCalledWith(SOURCE, 'music')
    expect(library.unpinMatch).not.toHaveBeenCalled()
  })

  it('keeps lossless decisions apart, which the library has no key for', async () => {
    const library = fakeLibrary()
    const store = matchStoreFrom(library)
    const lossless: MatchKey = { ...song, target: 'lossless' }

    await store.put(lossless, decision)

    await expect(store.get(lossless)).resolves.toEqual(decision)
    await expect(store.get(song)).resolves.toBeUndefined()
    expect(library.recordMatch).not.toHaveBeenCalled()
    await store.delete(lossless)
    await expect(store.get(lossless)).resolves.toBeUndefined()
  })

  it('reads nothing malformed back', async () => {
    const library = fakeLibrary()
    library.records.set(`${SOURCE}|music`, { band: 'auto', userPinned: 'yes' })

    await expect(matchStoreFrom(library).get(song)).resolves.toBeUndefined()
  })
})
