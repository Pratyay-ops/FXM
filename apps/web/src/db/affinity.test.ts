import {
  AFFINITY_HALF_LIFE_MS,
  AFFINITY_MODEL_VERSION,
  type AffinityEntry,
  affinityAt,
  affinityEntryId as affinityId,
  createSeededRandom,
  DEFAULT_AFFINITY_WEIGHTS,
  type EntityId,
  entityKey,
  formatId,
  type RandomSource,
  type Track,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { testRepo, track, tracks } from '../test/library-fixtures'
import {
  AFFINITY_MODEL_SETTING,
  addedAtOf,
  CLOCK_SKEW_MS,
  effectiveRecord,
  librarySignals,
} from './affinity'
import { exportLibrary, importLibrary, parseBackup } from './backup'
import { type LibraryRepo, type NewPlay, playRejection } from './repo'
import { DOWNLOADS_PLAYLIST_ID, LIKED_PLAYLIST_ID, type PlaylistRecord } from './types'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 1, 12)
const { like: LIKE, playlistAdd: ADD } = DEFAULT_AFFINITY_WEIGHTS

/** A test repository, which also hands over its database to look at what is stored. */
type TestRepo = ReturnType<typeof testRepo>

/** A repository whose clock stands still until the test moves it. */
function setup(start = T0) {
  let clock = start
  const repo = testRepo({ now: () => clock })
  return {
    repo,
    now: () => clock,
    set(time: number) {
      clock = time
    },
  }
}

/** Every stored entry's affinity at `now`, by record ID. */
async function scores(repo: TestRepo, now: number) {
  const records = await repo.db.affinity.toArray()
  return Object.fromEntries(
    records.map((record) => {
      const { score, skips } = affinityAt(record, now)
      return [record.id, { score, skips, plays: record.plays }]
    }),
  )
}

/** The stored entry with `id`. */
async function stored(repo: TestRepo, id: string): Promise<AffinityEntry | undefined> {
  return repo.db.affinity.get(id)
}

const trackId = (n: number) =>
  affinityId('track', `youtube:track:video${String(n).padStart(4, '0')}`)
const artistId = (n: number) => affinityId('artist', `artist ${n}`)

/** `track(n)` under its plain YouTube spelling. */
const ytTrack = (n: number, overrides: Partial<Track> = {}): Track => ({
  ...track(n),
  id: formatId('yt', 'track', `video${String(n).padStart(4, '0')}`),
  source: 'yt',
  ...overrides,
})

/**
 * Checks that the affinity the repository kept up to date, change by change, is what a rebuild
 * from the library gives: the same entries, with the same affinity and skips at `now` and the
 * same plays. Only artists and tags may remember a later last play.
 */
async function expectRebuildEquals(repo: TestRepo, now: number) {
  const incremental = await repo.db.affinity.toArray()
  await repo.rebuildAffinity()
  const rebuilt = new Map((await repo.db.affinity.toArray()).map((record) => [record.id, record]))
  expect(incremental.map((record) => record.id).sort()).toEqual([...rebuilt.keys()].sort())
  for (const record of incremental) {
    const other = rebuilt.get(record.id) as AffinityEntry
    const mine = affinityAt(record, now)
    const theirs = affinityAt(other, now)
    expect(mine.score, record.id).toBeCloseTo(theirs.score, 9)
    expect(mine.skips, record.id).toBeCloseTo(theirs.skips, 9)
    expect(record.plays, record.id).toBe(other.plays)
    if (record.kind === 'track') expect(record.lastPlayedAt, record.id).toBe(other.lastPlayedAt)
    else {
      expect(record.lastPlayedAt ?? -1, record.id).toBeGreaterThanOrEqual(other.lastPlayedAt ?? -1)
    }
  }
}

describe('the listening affinity in the library', () => {
  it('grows with a like and forgets it when the like is taken back', async () => {
    const { repo, set } = setup()
    await repo.like(track(1))
    expect(await scores(repo, T0)).toEqual({
      [trackId(1)]: { score: LIKE, skips: 0, plays: 0 },
      [artistId(1)]: { score: LIKE, skips: 0, plays: 0 },
    })
    expect(await stored(repo, trackId(1))).toMatchObject({
      kind: 'track',
      label: 'Song 1',
      ids: [track(1).id],
      at: T0,
    })

    set(T0 + 40 * DAY)
    expect(await repo.unlike(track(1).id)).toBe(true)
    expect(await repo.db.affinity.count()).toBe(0)
    expect(await repo.unlike(track(1).id)).toBe(false)
  })

  it('follows a like toggled on and off', async () => {
    const { repo } = setup()
    expect(await repo.toggleLike(track(1))).toBe(true)
    expect((await stored(repo, trackId(1)))?.score).toBe(LIKE)
    expect(await repo.toggleLike(track(1))).toBe(false)
    expect(await stored(repo, trackId(1))).toBeUndefined()
  })

  it('scores tracks added to playlists, and takes removals back', async () => {
    const { repo, set } = setup()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: [track(1), track(2)] })
    set(T0 + DAY)
    await repo.addTracks(id, [track(2), track(3)])
    expect(await scores(repo, T0 + DAY)).toMatchObject({
      [trackId(1)]: { score: expect.closeTo(ADD * 2 ** (-1 / 14), 9) },
      [trackId(3)]: { score: ADD },
    })
    set(T0 + 2 * DAY)
    expect(await repo.removeTracks(id, [track(1).id, track(9).id])).toBe(1)
    expect(await stored(repo, trackId(1))).toBeUndefined()
    expect(await stored(repo, artistId(1))).toBeUndefined()
    expect(await stored(repo, trackId(2))).toBeDefined()
  })

  it('likes tracks added to Liked songs, and unlikes the ones removed from it', async () => {
    const { repo } = setup()
    expect(await repo.addTracks(LIKED_PLAYLIST_ID, [track(1), track(2)])).toEqual({
      added: 2,
      skipped: 0,
    })
    expect(await scores(repo, T0)).toMatchObject({
      [trackId(1)]: { score: LIKE },
      [trackId(2)]: { score: LIKE },
    })
    expect(await repo.removeTracks(LIKED_PLAYLIST_ID, [track(1).id])).toBe(1)
    expect(await stored(repo, trackId(1))).toBeUndefined()
    expect(await stored(repo, trackId(2))).toBeDefined()
  })

  it('forgets what a deleted playlist added, and counts a copy like any playlist', async () => {
    const { repo, set } = setup()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: [track(1)] })
    set(T0 + DAY)
    const copy = await repo.duplicatePlaylist(id)
    // Both adds count from the day the track was first added.
    expect(await stored(repo, trackId(1))).toMatchObject({ at: T0, score: 2 * ADD })
    await repo.deletePlaylist(id)
    // The copy keeps the date the track was first added.
    expect((await scores(repo, T0))[trackId(1)]?.score).toBeCloseTo(ADD, 9)
    await repo.deletePlaylist(copy)
    expect(await repo.db.affinity.count()).toBe(0)
  })

  it('counts a download like a playlist add, until the download is deleted', async () => {
    const { repo } = setup()
    await repo.addDownload(track(1))
    await repo.addDownload(track(1))
    expect((await stored(repo, trackId(1)))?.score).toBe(ADD)
    await repo.removeDownload(track(1).id)
    expect(await stored(repo, trackId(1))).toBeUndefined()
  })

  it('scores plays by the share played, and skips by the share left', async () => {
    const { repo } = setup()
    const song = track(1, { durationMs: 200_000 })
    await repo.recordPlay({ track: song, playedMs: 200_000, completed: true, skipped: false })
    await repo.recordPlay({
      track: song,
      playedAt: T0 - 1000,
      playedMs: 10_000,
      durationMs: 200_000,
      completed: false,
      skipped: true,
    })
    const entry = await stored(repo, trackId(1))
    expect(entry).toMatchObject({ plays: 2, lastPlayedAt: T0, at: T0 })
    // The skip came a second earlier, so it has faded a little by the time of the last play.
    const fade = 2 ** (-1000 / AFFINITY_HALF_LIFE_MS)
    expect(entry?.score).toBeCloseTo(1 + 0.05 * fade, 12)
    expect(entry?.skips).toBeCloseTo(0.95 * fade, 12)
    expect((await repo.history())[0]).toMatchObject({ durationMs: 200_000, skipped: true })
  })

  it('keys artists by name across sources, and scores tags', async () => {
    const { repo } = setup()
    const ytm: Track = track(1, {
      artists: [{ id: formatId('ytm', 'artist', 'UC1'), name: 'Band' }],
      tags: ['Hip-Hop'],
    })
    const spotify: Track = {
      ...track(2),
      id: formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC'),
      source: 'spotify',
      artists: [{ id: formatId('spotify', 'artist', 'band'), name: 'BAND' }],
      tags: ['hip hop'],
    }
    await repo.like(ytm)
    await repo.like(spotify)
    expect(await stored(repo, affinityId('artist', 'band'))).toMatchObject({
      score: 2 * LIKE,
      ids: ['spotify:artist:band', 'ytm:artist:UC1'],
    })
    expect(await stored(repo, affinityId('tag', 'hip hop'))).toMatchObject({ score: 2 * LIKE })
  })

  it('shares one entry between the two YouTube spellings of a track', async () => {
    const { repo } = setup()
    const ytm = track(1)
    const yt: Track = { ...ytm, id: formatId('yt', 'track', 'video0001'), source: 'yt' }
    await repo.like(ytm)
    await repo.recordPlay({ track: yt, playedMs: 181_000, completed: true, skipped: false })
    expect(await stored(repo, trackId(1))).toMatchObject({ score: LIKE + 1, plays: 1 })
  })

  it('reads the top entries now, and single entries by key', async () => {
    const { repo, set } = setup()
    await repo.like(track(1))
    set(T0 + 20 * DAY)
    for (const at of [1, 2, 3]) {
      await repo.recordPlay({
        track: track(2),
        playedAt: T0 + 20 * DAY - at,
        playedMs: 182_000,
        completed: true,
        skipped: false,
      })
    }
    const top = await repo.topAffinity('track')
    expect(top.map(({ entry }) => entry.label)).toEqual(['Song 2', 'Song 1'])
    expect(top[0]?.score).toBeCloseTo(3, 6)
    expect(top[1]?.score).toBeCloseTo(LIKE * 2 ** (-20 / 14), 9)
    expect((await repo.topAffinity('track', 1)).map(({ entry }) => entry.label)).toEqual(['Song 2'])
    expect(await repo.topAffinity('track', 0)).toEqual([])
    expect(await repo.topAffinity('tag')).toEqual([])

    set(T0 + 34 * DAY)
    const [song1, missing] = await repo.getAffinity('track', [
      'youtube:track:video0001',
      'youtube:track:video0404',
    ])
    expect(song1?.score).toBeCloseTo(LIKE * 2 ** (-34 / 14), 9)
    expect(missing).toBeUndefined()
    expect((await repo.getAffinity('artist', ['artist 2']))[0]?.entry.plays).toBe(3)
  })

  it('reads entries by track ID, artist name or tag, as well as by key', async () => {
    const { repo, set } = setup()
    await repo.like(track(1, { tags: ['Hip-Hop'] }))
    set(T0 + 14 * DAY)
    const [byId, byOtherSpelling, byKey] = await repo.getAffinity('track', [
      track(1).id,
      ytTrack(1).id,
      'youtube:track:video0001',
    ])
    expect(byId?.score).toBeCloseTo(LIKE / 2, 12)
    expect(byOtherSpelling?.entry).toEqual(byId?.entry)
    expect(byKey?.entry).toEqual(byId?.entry)
    const artists = await repo.getAffinity('artist', ['Artist 1', 'Artist 1 - Topic', 'artist 1'])
    expect(artists.map((one) => one?.score)).toEqual(Array(3).fill(byId?.score))
    expect((await repo.getAffinity('tag', ['HIP_HOP']))[0]?.entry.key).toBe('hip hop')
    expect(await repo.getAffinity('artist', ['Various Artists', ''])).toEqual([
      undefined,
      undefined,
    ])
  })

  it('reads through the AffinityReader interface, at its clock or another time', async () => {
    const { repo, set } = setup()
    await repo.like(track(1))
    await repo.recordPlay({ track: track(2), playedMs: 182_000, completed: true, skipped: false })
    set(T0 + 14 * DAY)
    const top = await repo.affinity.top('track')
    expect(top.map(({ entry, score }) => [entry.label, score])).toEqual([
      ['Song 1', LIKE / 2],
      ['Song 2', 0.5],
    ])
    expect((await repo.affinity.top('track', { limit: 1, now: T0 }))[0]?.score).toBe(LIKE)
    const [song2] = await repo.affinity.scores('track', [track(2).id], { now: T0 })
    expect(song2?.score).toBe(1)
    expect(repo.now()).toBe(T0 + 14 * DAY)
  })

  it('leaves out of the top entries those without affinity', async () => {
    const { repo } = setup()
    await repo.recordPlay({ track: track(1), playedMs: 0, completed: false, skipped: true })
    expect(await repo.db.affinity.count()).toBe(2)
    expect(await repo.topAffinity('track')).toEqual([])
  })

  it('forgets every play when the history is cleared, and keeps likes and playlists', async () => {
    const { repo } = setup()
    await repo.like(track(1))
    await repo.createPlaylist({ name: 'Mix', tracks: [track(2)] })
    await repo.recordPlay({ track: track(1), playedMs: 181_000, completed: true, skipped: false })
    await repo.recordPlay({ track: track(3), playedMs: 1000, completed: false, skipped: true })
    await repo.clearHistory()
    expect(await scores(repo, T0)).toEqual({
      [trackId(1)]: { score: LIKE, skips: 0, plays: 0 },
      [artistId(1)]: { score: LIKE, skips: 0, plays: 0 },
      [trackId(2)]: { score: ADD, skips: 0, plays: 0 },
      [artistId(2)]: { score: ADD, skips: 0, plays: 0 },
    })
  })

  it('rebuilds exactly what the changes added up to one by one', async () => {
    const { repo, set } = setup()
    // The same metadata every time: see the next test for what happens when it changes.
    const song = (n: number) => track(n, n % 2 === 0 ? { tags: ['Ambient', `mood ${n}`] } : {})
    const mix = await repo.createPlaylist({ name: 'Mix', tracks: [1, 2, 3, 4, 5].map(song) })
    set(T0 + DAY)
    await repo.like(song(2))
    await repo.like(song(3))
    await repo.removeTracks(mix, [song(3).id])
    set(T0 + 3 * DAY)
    for (const [index, n] of [1, 2, 2, 6].entries()) {
      await repo.recordPlay({
        track: song(n),
        playedAt: T0 + 2 * DAY + index,
        playedMs: n * 20_000,
        completed: n === 2,
        skipped: n !== 2,
      })
    }
    await repo.unlike(song(2).id)
    const copy = await repo.duplicatePlaylist(LIKED_PLAYLIST_ID)
    set(T0 + 9 * DAY)
    await repo.addTracks(copy, [song(7)])
    await repo.deletePlaylist(mix)
    await repo.addDownload(song(8))
    await repo.addDownload(song(9))
    await repo.removeDownload(song(8).id)
    const now = T0 + 30 * DAY
    const incremental = await scores(repo, now)

    expect(await repo.rebuildAffinity()).toBe(Object.keys(incremental).length)

    const rebuilt = await scores(repo, now)
    expect(Object.keys(rebuilt).sort()).toEqual(Object.keys(incremental).sort())
    for (const [id, value] of Object.entries(incremental)) {
      expect(rebuilt[id]?.score, id).toBeCloseTo(value.score, 9)
      expect(rebuilt[id]?.skips, id).toBeCloseTo(value.skips, 9)
      expect(rebuilt[id]?.plays, id).toBe(value.plays)
    }
  })
})

describe('metadata that changes', () => {
  it('moves what a track holds to the artists and tags it gains, as a rebuild would', async () => {
    const { repo } = setup()
    await repo.like(track(1))
    // The track comes back with tags, e.g. from another source.
    await repo.recordPlay({
      track: track(1, { tags: ['jazz'] }),
      playedMs: 181_000,
      completed: true,
      skipped: false,
    })
    expect((await stored(repo, affinityId('tag', 'jazz')))?.score).toBe(LIKE + 1)
    await expectRebuildEquals(repo, T0)
  })

  it('takes a like back exactly after the track gained a guest and a tag', async () => {
    const { repo, set } = setup()
    await repo.like(track(1))
    set(T0 + DAY)
    await repo.recordPlay({
      track: track(1, { artists: [{ name: 'Artist 1' }, { name: 'Guest' }], tags: ['jazz'] }),
      playedMs: 181_000,
      completed: true,
      skipped: false,
    })
    await repo.unlike(track(1).id)
    const records = await repo.db.affinity.toArray()
    for (const record of records) expect(record.score, record.id).toBeGreaterThanOrEqual(0)
    expect(await stored(repo, affinityId('artist', 'guest'))).toMatchObject({ score: 0.5 })
    expect(await stored(repo, affinityId('tag', 'jazz'))).toMatchObject({ score: 1 })
    expect((await repo.getAffinity('tag', ['jazz']))[0]?.score).toBe(1)
    await expectRebuildEquals(repo, T0 + DAY)
  })

  it('takes a playlist add back exactly after the cache learned tags', async () => {
    const { repo } = setup()
    const id = await repo.createPlaylist({ name: 'Mix', tracks: [track(2)] })
    await repo.saveTracks([track(2, { tags: ['ambient'] })])
    expect(await stored(repo, affinityId('tag', 'ambient'))).toMatchObject({ score: ADD })
    await repo.removeTracks(id, [track(2).id])
    expect(await repo.db.affinity.count()).toBe(0)
  })

  it('moves what a track holds when its tags are read again, as local files do', async () => {
    const { repo } = setup()
    await repo.like(track(1))
    const retagged = track(1, { artists: [{ name: 'Someone' }], tags: ['folk'] })
    expect(await repo.refreshTracks([retagged])).toBe(1)
    expect(await stored(repo, artistId(1))).toBeUndefined()
    expect(await stored(repo, affinityId('artist', 'someone'))).toMatchObject({ score: LIKE })
    expect(await stored(repo, affinityId('tag', 'folk'))).toMatchObject({ score: LIKE })
    await expectRebuildEquals(repo, T0)
  })

  it('credits the artist the track is credited to now, not the one it was liked with', async () => {
    const { repo } = setup()
    await repo.like(track(1))
    await repo.recordPlay({
      track: track(1, { artists: [{ name: 'Artist One' }], tags: ['rock'] }),
      playedMs: 181_000,
      completed: true,
      skipped: false,
    })
    await repo.unlike(track(1).id)
    expect(await stored(repo, artistId(1))).toBeUndefined()
    expect(
      (await repo.topAffinity('artist')).map(({ entry, score }) => [entry.key, score]),
    ).toEqual([['artist one', 1]])
    expect((await stored(repo, affinityId('tag', 'rock')))?.score).toBe(1)
  })

  it('stops crediting artists when a track turns out to be a plain video', async () => {
    const { repo } = setup()
    await repo.like(track(1))
    await repo.saveTracks([track(1, { kind: 'video' })])
    expect(await stored(repo, artistId(1))).toBeUndefined()
    expect(await stored(repo, trackId(1))).toMatchObject({ score: LIKE })
  })

  it('scores both YouTube spellings of a track with the metadata saved last', async () => {
    const { repo, set } = setup()
    await repo.like(track(1))
    set(T0 + 1000)
    await repo.recordPlay({
      track: ytTrack(1, { artists: [{ name: 'Channel' }] }),
      playedMs: 181_000,
      completed: true,
      skipped: false,
    })
    // Both the like and the play now credit the channel, the latest metadata of the video.
    expect(await stored(repo, artistId(1))).toBeUndefined()
    expect((await stored(repo, affinityId('artist', 'channel')))?.plays).toBe(1)
    set(T0 + 2000)
    await repo.saveTracks([track(1)])
    expect(await stored(repo, affinityId('artist', 'channel'))).toBeUndefined()
    await expectRebuildEquals(repo, T0 + 2000)
    // Lists keep showing each spelling with its own metadata.
    expect((await repo.getTrack(ytTrack(1).id))?.artists).toEqual([{ name: 'Channel' }])
  })

  it('picks the spelling saved last, and the greater ID when both were saved at once', () => {
    const row = (id: EntityId<'track'>, updatedAt: number) => ({ id, track: track(1), updatedAt })
    const ytm = track(1).id
    const yt = ytTrack(1).id
    expect(effectiveRecord([row(ytm, 2), row(yt, 1)])?.id).toBe(ytm)
    expect(effectiveRecord([row(ytm, 1), undefined, row(yt, 2)])?.id).toBe(yt)
    expect(effectiveRecord([row(yt, 1), row(ytm, 1)])?.id).toBe(ytm)
    expect(effectiveRecord([undefined])).toBeUndefined()
  })

  it.each([1, 2, 3, 4])(
    'stays what a rebuild gives through any mix of changes (seed %i)',
    async (seed) => {
      const random = createSeededRandom(seed)
      let clock = T0
      const repo = testRepo({ now: () => clock, random })
      await randomChanges(repo, random, 70, (ms) => {
        clock += ms
      })
      await expectRebuildEquals(repo, clock)
    },
  )
})

/** The metadata `track(n)` may come with: from search, an album, another source... */
function variant(random: RandomSource, n: number): Track {
  const spelling = random() < 0.3 ? ytTrack(n) : track(n)
  const pick = Math.floor(random() * 5)
  const extra: Partial<Track>[] = [
    {},
    { artists: [{ name: `Artist ${n}` }, { name: 'Guest' }] },
    { tags: ['jazz', `mood ${n % 3}`] },
    { artists: [{ name: `Other ${n % 4}` }], tags: ['Rock'] },
    { kind: 'video' },
  ]
  return { ...spelling, ...extra[pick] }
}

/** `count` random changes of the library, the clock moving on between them. */
async function randomChanges(
  repo: LibraryRepo,
  random: RandomSource,
  count: number,
  advance: (ms: number) => void,
) {
  const playlists: EntityId<'playlist'>[] = []
  const someTrack = () => variant(random, 1 + Math.floor(random() * 6))
  const somePlaylist = () => playlists[Math.floor(random() * playlists.length)]
  for (let step = 0; step < count; step++) {
    advance(Math.floor(random() * 6 * 60 * 60 * 1000))
    const roll = random()
    const one = someTrack()
    if (roll < 0.25) {
      const durationMs = one.durationMs ?? 200_000
      await repo.recordPlay({
        track: one,
        playedAt: repo.now() - Math.floor(random() * 1000),
        playedMs: Math.floor(random() * durationMs),
        durationMs,
        completed: random() < 0.4,
        skipped: random() < 0.5,
      })
    } else if (roll < 0.35) await repo.toggleLike(one)
    else if (roll < 0.4) await repo.unlike(one.id)
    else if (roll < 0.5) await repo.saveTracks([one])
    else if (roll < 0.58) {
      playlists.push(await repo.createPlaylist({ name: 'Mix', tracks: [one, someTrack()] }))
    } else if (roll < 0.68 && playlists.length > 0) {
      await repo.addTracks(somePlaylist() as EntityId<'playlist'>, [one, someTrack()])
    } else if (roll < 0.76 && playlists.length > 0) {
      await repo.removeTracks(somePlaylist() as EntityId<'playlist'>, [one.id])
    } else if (roll < 0.8 && playlists.length > 0) {
      const id = playlists.splice(Math.floor(random() * playlists.length), 1)[0]
      await repo.deletePlaylist(id as EntityId<'playlist'>)
    } else if (roll < 0.84) {
      playlists.push(await repo.duplicatePlaylist(playlists[0] ?? LIKED_PLAYLIST_ID))
    } else if (roll < 0.9) await repo.addTracks(LIKED_PLAYLIST_ID, [one])
    else if (roll < 0.93) await repo.removeTracks(LIKED_PLAYLIST_ID, [one.id])
    else if (roll < 0.97) await repo.addDownload(one)
    else await repo.removeDownload(one.id)
  }
}

describe('recordPlays: the event API for plays', () => {
  it('records a batch in one go, with the tracks and their signals', async () => {
    const { repo } = setup()
    const ids = await repo.recordPlays([
      {
        track: track(1),
        playedAt: T0 - 2 * DAY,
        playedMs: 181_000,
        completed: true,
        skipped: false,
      },
      { track: track(2), playedAt: T0 - DAY, playedMs: 5_000, completed: false, skipped: true },
    ])
    expect(ids).toHaveLength(2)
    expect(await repo.getTrack(track(2).id)).toEqual(track(2))
    expect((await repo.history()).map((entry) => entry.id)).toEqual(ids)
    expect(await repo.db.affinity.count()).toBe(4)
    expect(await repo.recordPlays([])).toEqual([])
  })

  it('records a play only once, also when an import runs again', async () => {
    const { repo } = setup()
    const play = {
      track: track(1),
      playedAt: T0 - DAY,
      playedMs: 60_000,
      completed: false,
      skipped: false,
      importId: 'import-1',
    }
    const [first] = await repo.recordPlays([play, { ...play }])
    const yt: Track = { ...track(1), id: formatId('yt', 'track', 'video0001'), source: 'yt' }
    // The same video under its other prefix is the same play.
    expect(await repo.recordPlays([{ ...play, track: yt }])).toEqual([first])
    const again = await repo.recordPlays([play, { ...play, playedAt: T0 - DAY + 1 }])
    expect(again[0]).toBe(first)
    expect(again[1]).not.toBe(first)
    expect(await repo.history()).toHaveLength(2)
    expect((await repo.history())[0]).toMatchObject({ importId: 'import-1' })
    expect((await stored(repo, trackId(1)))?.plays).toBe(2)
  })

  it('keeps every spelling of a track it caches', async () => {
    const { repo } = setup()
    const yt: Track = { ...track(1), id: formatId('yt', 'track', 'video0001'), source: 'yt' }
    await repo.recordPlays([
      { track: track(1), playedMs: 1000, completed: false, skipped: false },
      { track: yt, playedAt: T0 - 5, playedMs: 1000, completed: false, skipped: false },
    ])
    expect(await repo.getTrack(track(1).id)).toBeDefined()
    expect(await repo.getTrack(yt.id)).toBeDefined()
  })

  it('takes the track’s own length over a useless one, and no time played as none', async () => {
    const { repo } = setup()
    await repo.recordPlay({
      track: track(1),
      playedAt: T0 - DAY,
      playedMs: -5,
      durationMs: Number.NaN,
      completed: false,
      skipped: false,
    })
    const { durationMs: _length, ...noLength } = track(2)
    await repo.recordPlay({ track: noLength, playedMs: 1, completed: false, skipped: false })
    const [first, second] = await repo.history()
    expect(first).toMatchObject({ playedAt: T0 - DAY, playedMs: 0, durationMs: 181_000 })
    expect(second).not.toHaveProperty('durationMs')
  })

  it('refuses a play that starts after now, also when a batch is recorded again', async () => {
    const { repo } = setup()
    const good: NewPlay = {
      track: track(1),
      playedAt: T0 - DAY,
      playedMs: 1000,
      completed: false,
      skipped: false,
    }
    const late: NewPlay = { ...good, track: track(2), playedAt: T0 + 1 }
    for (let run = 0; run < 2; run++) {
      await expect(repo.recordPlays([good, late])).rejects.toMatchObject({ code: 'invalid' })
    }
    expect(await repo.history()).toEqual([])
    expect(playRejection(late, T0)).toMatch(/after now/)
    expect(playRejection(good, T0)).toBeUndefined()
    // An import checks every row first, and records the good ones once.
    const rows = [good, late, { ...good }].filter((play) => playRejection(play, T0) === undefined)
    for (let run = 0; run < 2; run++) await repo.recordPlays(rows)
    expect(await repo.history()).toHaveLength(1)
  })

  it('keeps the fuller record of a play recorded twice, and the affinity follows', async () => {
    const { repo } = setup()
    const play: NewPlay = {
      track: track(1),
      playedAt: T0 - 60_000,
      playedMs: 30_000,
      durationMs: 200_000,
      completed: false,
      skipped: false,
    }
    // A checkpoint of the play, then the player's own record of it, then the checkpoint again.
    const [id] = await repo.recordPlays([play])
    const final = { ...play, playedMs: 50_000, skipped: true }
    expect(await repo.recordPlays([final])).toEqual([id])
    expect(await repo.recordPlays([play])).toEqual([id])
    expect(await repo.history()).toEqual([
      expect.objectContaining({ id, playedMs: 50_000, skipped: true, completed: false }),
    ])
    const entry = await stored(repo, trackId(1))
    expect(entry).toMatchObject({ plays: 1 })
    expect(affinityAt(entry as AffinityEntry, T0).score).toBeCloseTo(
      0.25 * 2 ** (-60_000 / AFFINITY_HALF_LIFE_MS),
      12,
    )
    expect(affinityAt(entry as AffinityEntry, T0).skips).toBeCloseTo(
      0.75 * 2 ** (-60_000 / AFFINITY_HALF_LIFE_MS),
      12,
    )
    // As much time with a verdict says more than without one.
    const ended = { ...play, playedAt: T0 - 1000, playedMs: 1000 }
    const [other] = await repo.recordPlays([ended])
    await repo.recordPlays([{ ...ended, completed: true }])
    expect((await repo.history()).find((row) => row.id === other)).toMatchObject({
      completed: true,
    })
    await expectRebuildEquals(repo, T0)
  })

  it('keeps cached metadata when an import asks it to', async () => {
    const { repo } = setup()
    const rich = track(1, { tags: ['jazz'], artists: [{ name: 'Artist 1' }, { name: 'Guest' }] })
    await repo.saveTracks([rich])
    const { album: _album, ...sparse } = track(1)
    const imported = (one: Track): NewPlay => ({
      track: one,
      playedAt: T0 - DAY,
      playedMs: 181_000,
      completed: true,
      skipped: false,
      importId: 'import-1',
    })
    await repo.recordPlays([imported(sparse)], { keepCachedTracks: true })
    expect(await repo.getTrack(rich.id)).toEqual(rich)
    expect((await stored(repo, affinityId('tag', 'jazz')))?.plays).toBe(1)
    // A video cached under its other prefix gives its metadata to the one the import names.
    await repo.recordPlays([imported({ ...ytTrack(1), artists: [] })], { keepCachedTracks: true })
    expect((await repo.getTrack(ytTrack(1).id))?.tags).toEqual(['jazz'])
    expect((await repo.getTrack(ytTrack(1).id))?.source).toBe('yt')
    // A track nobody cached yet is cached as the import has it.
    await repo.recordPlays([imported(track(2))], { keepCachedTracks: true })
    expect(await repo.getTrack(track(2).id)).toEqual(track(2))
  })

  it.each([
    ['a start that is not a number', { playedAt: Number.NaN }],
    ['a negative start', { playedAt: -1 }],
    ['a time played that is not a number', { playedMs: Number.POSITIVE_INFINITY }],
    ['an invalid track ID', { track: { ...track(1), id: 'nope' as EntityId<'track'> } }],
  ])('refuses a play with %s, and records nothing of its batch', async (_name, patch) => {
    const { repo } = setup()
    const good = { track: track(2), playedMs: 1000, completed: false, skipped: false }
    await expect(repo.recordPlays([good, { ...good, ...patch }])).rejects.toMatchObject({
      code: 'invalid',
    })
    expect(await repo.history()).toEqual([])
    expect(await repo.db.affinity.count()).toBe(0)
  })
})

describe('undoing an import', () => {
  it('forgets the plays an import brought in, and what they added', async () => {
    const { repo } = setup()
    const play = (n: number, importId?: string): NewPlay => ({
      track: track(n),
      playedAt: T0 - n * DAY,
      playedMs: 181_000,
      completed: true,
      skipped: false,
      ...(importId === undefined ? {} : { importId }),
    })
    await repo.recordPlays([play(1, 'import-1'), play(2, 'import-1'), play(3, 'import-2')])
    await repo.recordPlay(play(4))
    await repo.like(track(1))
    expect(await repo.forgetImportPlays('import-1')).toBe(2)
    expect((await repo.history()).map((entry) => entry.trackId)).toEqual([track(4).id, track(3).id])
    expect(await stored(repo, trackId(2))).toBeUndefined()
    expect(await stored(repo, trackId(1))).toMatchObject({ plays: 0, score: LIKE })
    expect(await repo.forgetImportPlays('import-1')).toBe(0)
  })
})

describe('maintenance', () => {
  it('leaves an affinity alone that fits the model and the clock', async () => {
    const { repo } = setup()
    await repo.like(track(1))
    await repo.rebuildAffinity()
    expect(await repo.maintainAffinity()).toBe(false)
    expect(await repo.db.settings.get(AFFINITY_MODEL_SETTING)).toMatchObject({
      value: AFFINITY_MODEL_VERSION,
    })
  })

  it('rebuilds an affinity built with another model', async () => {
    const { repo } = setup()
    await repo.like(track(1))
    // Version 3 libraries record the model when they rebuild; this one predates that, or the
    // weights changed since.
    await repo.db.affinity.update(trackId(1), { score: 99 })
    expect(await repo.maintainAffinity()).toBe(true)
    expect((await stored(repo, trackId(1)))?.score).toBe(LIKE)
    expect(await repo.maintainAffinity()).toBe(false)
    await repo.db.settings.put({ key: AFFINITY_MODEL_SETTING, value: 0, updatedAt: T0 })
    expect(await repo.maintainAffinity()).toBe(true)
  })

  it('brings times after the clock back to it when the clock went back', async () => {
    const { repo, set } = setup(T0 + 30 * DAY)
    // Liked and added while the clock ran a month ahead.
    await repo.like(track(1))
    const id = await repo.createPlaylist({ name: 'Mix', tracks: [track(2)] })
    await repo.recordPlay({ track: track(3), playedMs: 183_000, completed: true, skipped: false })
    await repo.rebuildAffinity()
    set(T0)
    expect(await repo.maintainAffinity()).toBe(true)
    expect((await repo.db.likes.toArray())[0]?.likedAt).toBe(T0)
    expect((await repo.history())[0]?.playedAt).toBe(T0)
    expect((await repo.getPlaylistView(id))?.playlist.addedAt[track(2).id]).toBe(T0)
    expect(await repo.db.affinity.where('at').above(T0).count()).toBe(0)
    // New plays count in full again, and the like can still be taken back exactly.
    set(T0 + DAY)
    await repo.recordPlay({ track: track(1), playedMs: 181_000, completed: true, skipped: false })
    expect((await stored(repo, trackId(1)))?.score).toBeCloseTo(LIKE * 2 ** (-1 / 14) + 1, 12)
    await repo.unlike(track(1).id)
    expect((await stored(repo, trackId(1)))?.score).toBeCloseTo(1, 12)
    expect(await repo.maintainAffinity()).toBe(false)
  })

  it('tolerates a clock that went back a little', async () => {
    const { repo, set } = setup(T0 + CLOCK_SKEW_MS)
    await repo.like(track(1))
    await repo.rebuildAffinity()
    set(T0)
    expect(await repo.maintainAffinity()).toBe(false)
  })
})

describe('librarySignals', () => {
  const at = T0
  const playlist = (overrides: Partial<PlaylistRecord>): PlaylistRecord => ({
    id: formatId('local', 'playlist', 'mine'),
    name: 'Mine',
    createdAt: at - DAY,
    updatedAt: at,
    trackIds: [],
    addedAt: {},
    ...overrides,
  })

  it('stands for plays, likes and playlist entries, but not Liked songs’ own entries', () => {
    const signals = librarySignals({
      history: [
        { trackId: track(1).id, playedAt: at, playedMs: 1, completed: false, skipped: true },
      ],
      likes: [{ key: 'youtube:track:video0002', trackId: track(2).id, likedAt: at }],
      playlists: [
        playlist({ trackIds: [track(3).id], addedAt: { [track(3).id]: at } }),
        playlist({ id: LIKED_PLAYLIST_ID, system: 'liked', trackIds: [track(2).id] }),
        playlist({ id: DOWNLOADS_PLAYLIST_ID, system: 'downloads', trackIds: [track(4).id] }),
      ],
      tracks: new Map([[entityKey(track(1).id), track(1)]]),
    })
    expect(signals.map((signal) => `${signal.type} ${signal.track.id}`)).toEqual([
      `play ${track(1).id}`,
      `like ${track(2).id}`,
      `playlist-add ${track(3).id}`,
      `playlist-add ${track(4).id}`,
    ])
    expect(signals[0]?.track).toEqual(track(1))
    // A track missing from the cache still counts for itself.
    expect(signals[1]?.track).toEqual({ id: track(2).id, title: '', artists: [] })
  })

  it('dates a playlist entry without a date of its own by the playlist’s creation', () => {
    const record = playlist({
      trackIds: [track(1).id, track(2).id],
      addedAt: { [track(1).id]: at },
    })
    expect(addedAtOf(record, track(1).id)).toBe(at)
    expect(addedAtOf(record, track(2).id)).toBe(at - DAY)
  })
})

describe('backups and the affinity', () => {
  async function library(repo: LibraryRepo) {
    await repo.createPlaylist({ name: 'Mix', tracks: tracks(3) })
    await repo.like(track(4, { tags: ['jazz'] }))
    await repo.recordPlay({ track: track(1), playedMs: 181_000, completed: true, skipped: false })
  }

  it('leaves the affinity out of a backup and rebuilds it on import', async () => {
    const source = setup()
    await library(source.repo)
    const backup = await exportLibrary(source.repo)
    expect(backup.tables).not.toHaveProperty('affinity')

    const target = setup()
    await target.repo.like(track(9))
    await importLibrary(target.repo, parseBackup(JSON.stringify(backup)), 'replace')
    expect(await scores(target.repo, T0)).toEqual(await scores(source.repo, T0))
  })

  it('rebuilds the affinity of a merged library from both sides', async () => {
    const source = setup()
    await library(source.repo)
    const backup = await exportLibrary(source.repo)

    const target = setup()
    await target.repo.like(track(9))
    await importLibrary(target.repo, parseBackup(JSON.stringify(backup)), 'merge')
    const merged = await scores(target.repo, T0)
    expect(merged[trackId(9)]).toEqual({ score: LIKE, skips: 0, plays: 0 })
    expect(merged[affinityId('tag', 'jazz')]).toEqual({ score: LIKE, skips: 0, plays: 0 })
    expect(merged[trackId(1)]?.plays).toBe(1)
  })

  it('keeps times after the clock out of the library, so they hold nothing back', async () => {
    // A backup from a device whose clock ran a year ahead.
    const source = setup(T0 + 365 * DAY)
    await source.repo.like(track(1))
    await source.repo.createPlaylist({ name: 'Mix', tracks: [track(2)] })
    await source.repo.recordPlay({
      track: track(3),
      playedMs: 183_000,
      completed: true,
      skipped: false,
    })
    const file = JSON.stringify(await exportLibrary(source.repo))

    const target = setup()
    for (let run = 0; run < 2; run++) {
      await importLibrary(target.repo, parseBackup(file), 'merge')
    }
    expect((await target.repo.db.likes.toArray())[0]?.likedAt).toBe(T0)
    expect(await target.repo.history()).toEqual([])
    expect(await target.repo.db.affinity.where('at').above(T0).count()).toBe(0)
    // Ten full plays over ten days count in full.
    for (let day = 1; day <= 10; day++) {
      target.set(T0 + day * DAY)
      await target.repo.recordPlay({
        track: track(1),
        playedMs: 181_000,
        completed: true,
        skipped: false,
      })
    }
    let plays = 0
    for (let day = 1; day <= 10; day++) plays += 2 ** (-(10 - day) / 14)
    expect((await target.repo.getAffinity('track', [track(1).id]))[0]?.score).toBeCloseTo(
      LIKE * 2 ** (-10 / 14) + plays,
      9,
    )
  })

  it('leaves the model the affinity was built with out of a backup', async () => {
    const { repo } = setup()
    await repo.like(track(1))
    await repo.rebuildAffinity()
    const backup = await exportLibrary(repo)
    expect(backup.tables.settings.map((row) => row.key)).not.toContain(AFFINITY_MODEL_SETTING)
    const stale = { key: AFFINITY_MODEL_SETTING, value: 0, updatedAt: T0 }
    backup.tables.settings.push(stale)
    await importLibrary(repo, parseBackup(JSON.stringify(backup)), 'replace')
    expect((await repo.db.settings.get(AFFINITY_MODEL_SETTING))?.value).toBe(AFFINITY_MODEL_VERSION)
  })
})
