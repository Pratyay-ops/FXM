import { type EntityId, formatId } from '@fxm/core'
import {
  createImportState,
  importBlockOf,
  initialPlaylistTracks,
  noSkips,
  type ParsedImport,
  rowFromTrack,
  YOUTUBE_IMPORT_UNAVAILABLE,
} from '@fxm/sources/import'
import {
  candidate,
  catalogScenario,
  fakeYouTube,
  song,
  spotifyTrack,
} from '@fxm/sources/import/testing'
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLibrary } from '../../db/repo'
import { ImportBusyError, setImportLockManager } from './locks'
import {
  confirmLikelyMatches,
  HISTORY_IMPORT_KIND,
  loadImportState,
  pauseImport,
  reopenRows,
  resetImportRunner,
  resumeImport,
  retryFailedSongs,
  reviewRow,
  StartImportsError,
  startImports,
  useImportRunner,
} from './runner'
import { fakeLocks, fakeServices } from './testing'

afterEach(() => {
  resetImportRunner()
  setImportLockManager(undefined)
})

/** A promise that waits until `open()` is called. */
function gate() {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

/**
 * A paused import of two Spotify songs: the first waits for review (a likely match), the second
 * has not been matched yet.
 */
async function pausedWithReview() {
  const tracks = [
    spotifyTrack(1, 'Known Song', 'Known Band', { seconds: 200 }),
    spotifyTrack(2, 'Second Song', 'Second Band', { seconds: 210 }),
  ]
  const parsed = parsedPlaylist('Half way', tracks)
  const collection = parsed.collections[0] as NonNullable<(typeof parsed.collections)[0]>
  const state = createImportState('spotify', 'music', collection)
  state.results[0] = {
    outcome: 'review',
    verdict: 'auto',
    best: candidate('knownsong01', 'Known Song', 'Known Band', 0.95),
    playlistTrackId: tracks[0]?.id as EntityId<'track'>,
  }
  const repo = getLibrary()
  const playlistId = await repo.createPlaylist({
    name: 'Half way',
    tracks: initialPlaylistTracks(collection),
  })
  const record = await repo.startImport({
    kind: 'spotify',
    label: 'Half way',
    total: 2,
    playlistId,
  })
  await repo.updateImport(record.id, {
    status: 'paused',
    state: state as never,
    done: 1,
    needsReview: 1,
  })
  const catalog = [
    song('knownsong01', 'Known Song', 'Known Band', { seconds: 200 }),
    song('secondsong1', 'Second Song', 'Second Band', { seconds: 210 }),
  ]
  return { id: record.id, tracks, catalog, playlistId }
}

function parsedPlaylist(name: string, tracks: Parameters<typeof rowFromTrack>[0][]): ParsedImport {
  return {
    kind: 'spotify',
    label: name,
    collections: [{ name, rows: tracks.map(rowFromTrack) }],
    plays: [],
    follows: [],
    skipped: noSkips(),
  }
}

async function statusOf(id: string) {
  return (await getLibrary().getImport(id))?.status
}

async function finished(id: string) {
  await waitFor(async () => expect(await statusOf(id)).toMatch(/done|paused|failed|cancelled/u))
  return (await getLibrary().getImport(id)) as NonNullable<
    Awaited<ReturnType<ReturnType<typeof getLibrary>['getImport']>>
  >
}

describe('startImports', () => {
  it('creates the playlist at once and matches it in the background', async () => {
    const scenario = catalogScenario([
      ['isrc', 6],
      ['text', 2],
      ['missing', 2],
    ])
    const services = fakeServices({ youtube: fakeYouTube({ catalog: scenario.catalog }) })
    const started = await startImports(
      parsedPlaylist('Mix', scenario.tracks),
      {},
      'music',
      services,
    )
    expect(started.importIds).toHaveLength(1)
    const id = started.importIds[0] as string
    const record = await finished(id)
    expect(record).toMatchObject({
      status: 'done',
      kind: 'spotify',
      label: 'Mix',
      total: 10,
      done: 10,
      matched: 8,
      needsReview: 2,
      failed: 0,
    })
    const repo = getLibrary()
    const view = await repo.getPlaylistView(record.playlistId as EntityId<'playlist'>)
    expect(view?.playlist.name).toBe('Mix')
    expect(view?.rows.map((row) => row.id)).toEqual(scenario.tracks.map((track) => track.id))
    const first = scenario.tracks[0]?.id as EntityId<'track'>
    // Auto matching is on in these fake services, so the match may play without asking.
    expect(await repo.getConfirmedMatch(first, 'music')).toMatchObject({
      ref: scenario.expected[0]?.ref,
    })
    expect(services.slots).toBeGreaterThanOrEqual(10)
  })

  it('records a data download’s listening history and follows its saved albums and artists', async () => {
    // As a data export describes it: no artwork.
    const creep = {
      ...spotifyTrack(1, 'Creep', 'Radiohead', { album: 'Pablo Honey' }),
      artwork: [],
    }
    const parsed: ParsedImport = {
      kind: 'spotify-export',
      label: 'Spotify data export',
      collections: [],
      plays: [
        {
          track: creep,
          playedAt: Date.UTC(2024, 0, 1),
          playedMs: 200_000,
          completed: true,
          skipped: false,
        },
        {
          track: creep,
          playedAt: Date.UTC(2024, 0, 2),
          playedMs: 10_000,
          completed: false,
          skipped: true,
        },
      ],
      follows: [
        {
          id: formatId('spotify', 'artist', '0000000000000000000006'),
          source: 'spotify',
          name: 'Björk',
          artwork: [],
        },
        {
          id: formatId('spotify', 'album', '0000000000000000000005'),
          source: 'spotify',
          name: 'Dummy',
          artists: [{ name: 'Portishead' }],
          artwork: [],
        },
      ],
      skipped: noSkips(),
    }
    // The library already describes the track, with artwork: the history keeps that.
    const known = { ...creep, artwork: [{ url: 'https://i.scdn.co/image/creep', width: 300 }] }
    await getLibrary().saveTracks([known])
    const started = await startImports(parsed, {}, 'music', fakeServices())
    expect(started).toMatchObject({ importIds: [], followed: 2 })
    expect((await getLibrary().getTrack(creep.id))?.artwork).toEqual(known.artwork)
    const repo = getLibrary()
    const history = await repo.history()
    expect(history).toHaveLength(2)
    expect(history.every((play) => play.importId === started.historyId)).toBe(true)
    expect(await repo.getImport(started.historyId as string)).toMatchObject({
      kind: HISTORY_IMPORT_KIND,
      status: 'done',
      total: 2,
      done: 2,
    })
    expect((await repo.listFollows('artist')).map((follow) => follow.name)).toEqual(['Björk'])
    expect((await repo.listFollows('album')).map((follow) => follow.name)).toEqual(['Dummy'])
    // The artist's affinity learned from the plays.
    expect((await repo.topAffinity('artist', 5)).map((entry) => entry.entry.label)).toContain(
      'Radiohead',
    )

    // Importing the same download again records nothing twice.
    await startImports(parsed, { follows: false }, 'music', fakeServices())
    expect(await repo.history()).toHaveLength(2)
  })

  it('keeps the library’s own description of a track a file only names', async () => {
    const known = spotifyTrack(7, 'Known', 'Band', { album: 'Album', seconds: 200 })
    await getLibrary().saveTracks([known])
    const parsed: ParsedImport = {
      kind: 'csv',
      label: 'x.csv',
      collections: [
        { name: 'File', rows: [{ title: 'known', artists: ['band'], trackId: known.id }] },
      ],
      plays: [],
      follows: [],
      skipped: noSkips(),
    }
    await startImports(parsed, {}, 'music', fakeServices())
    expect(await getLibrary().getTrack(known.id)).toEqual(known)
  })

  it('creates only the chosen playlists, under the names the user gave', async () => {
    const parsed: ParsedImport = {
      kind: 'csv',
      label: 'x.csv',
      collections: [
        { name: 'A', rows: [{ title: 'One', artists: ['X'] }] },
        { name: 'B', rows: [{ title: 'Two', artists: ['Y'] }] },
      ],
      plays: [],
      follows: [],
      skipped: noSkips(),
    }
    const started = await startImports(
      parsed,
      { collections: [1], names: { 1: '  Renamed  ' } },
      'all',
      fakeServices(),
    )
    const record = await finished(started.importIds[0] as string)
    expect(record.label).toBe('Renamed')
    const state = await loadImportState(record.id)
    expect(state?.mode).toBe('all')
    expect(state?.rows.map((row) => row.title)).toEqual(['Two'])
  })
})

describe('pausing and resuming', () => {
  it('pauses where it is, and resumes from there', async () => {
    const scenario = catalogScenario([['isrc', 4]])
    const youtube = fakeYouTube({ catalog: scenario.catalog })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = fakeServices({
      youtube,
      async waitForBulkSlot(signal) {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          void gate.then(resolve)
        })
      },
    })
    const [id] = (await startImports(parsedPlaylist('Slow', scenario.tracks), {}, 'music', slow))
      .importIds
    await waitFor(async () => expect(await statusOf(id as string)).toBe('running'))
    await pauseImport(id as string)
    const paused = await finished(id as string)
    expect(paused).toMatchObject({ status: 'paused', done: 0 })
    release()

    await resumeImport(id as string, fakeServices({ youtube }))
    const done = await finished(id as string)
    expect(done).toMatchObject({ status: 'done', done: 4, matched: 4 })
  })

  it('pauses with a note while YouTube Music can’t be reached, keeping the rows', async () => {
    const services = fakeServices({
      youtube: YOUTUBE_IMPORT_UNAVAILABLE,
      capabilities: () => ({
        youtube: 'none',
        spotify: 'unreachable',
        mediaBytes: false,
        fileSystem: false,
      }),
    })
    const tracks = [spotifyTrack(1, 'Song', 'Band', { seconds: 200 })]
    const [id] = (await startImports(parsedPlaylist('Blocked', tracks), {}, 'music', services))
      .importIds
    const record = await finished(id as string)
    expect(record.status).toBe('paused')
    // Why is in the progress, for the page to say in its own words; it is no failure.
    expect(importBlockOf(record.state)).toBe('unsupported')
    expect(record.error).toBe('')
    expect(record.done).toBe(0)
  })

  it('fails an import whose progress can’t be read', async () => {
    const repo = getLibrary()
    const record = await repo.startImport({
      kind: 'csv',
      label: 'Broken',
      total: 1,
      state: { version: 99 },
    })
    await repo.updateImport(record.id, { status: 'paused' })
    await resumeImport(record.id, fakeServices())
    const failed = await finished(record.id)
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/can’t be read/u)
  })
})

describe('retrying', () => {
  it('tries the failed songs of an import again', async () => {
    const known = song('knownsong01', 'Known Song', 'Known Band', { seconds: 200 })
    const rows = [{ title: '', artists: [], trackId: known.id }]
    const parsed: ParsedImport = {
      kind: 'm3u',
      label: 'm3u',
      collections: [{ name: 'Links', rows }],
      plays: [],
      follows: [],
      skipped: noSkips(),
    }
    // The first attempt finds no such video; the second one does.
    const [id] = (await startImports(parsed, {}, 'music', fakeServices())).importIds
    const first = await finished(id as string)
    expect(first).toMatchObject({ status: 'done', failed: 1 })
    expect(
      await retryFailedSongs(
        id as string,
        fakeServices({ youtube: fakeYouTube({ catalog: [known] }) }),
      ),
    ).toBe(1)
    const second = await finished(id as string)
    expect(second).toMatchObject({ status: 'done', failed: 0, matched: 1 })
  })
})

describe('reviewing', () => {
  it('pins a confirmed match, places a confirmed song, and skips', async () => {
    const known = song('knownsong01', 'Known Song', 'Known Band', { seconds: 200 })
    const tracks = [spotifyTrack(1, 'Known Song', 'Known Band', { seconds: 200 })]
    const services = fakeServices({
      youtube: fakeYouTube({ catalog: [known] }),
      autoMatch: () => false,
    })
    const [spotifyId] = (
      await startImports(parsedPlaylist('Spotify', tracks), {}, 'music', services)
    ).importIds
    await finished(spotifyId as string)
    expect(
      await getLibrary().getConfirmedMatch(tracks[0]?.id as EntityId<'track'>, 'music'),
    ).toBeUndefined()
    await reviewRow(spotifyId as string, 0, { action: 'confirm', ref: 'knownsong01' })
    expect(
      await getLibrary().getConfirmedMatch(tracks[0]?.id as EntityId<'track'>, 'music'),
    ).toMatchObject({
      ref: 'knownsong01',
    })
    expect(await getLibrary().getImport(spotifyId as string)).toMatchObject({
      matched: 1,
      needsReview: 0,
    })

    const csv: ParsedImport = {
      kind: 'csv',
      label: 'csv',
      collections: [
        {
          name: 'From CSV',
          rows: [
            { title: 'Known Song', artists: ['Known Band'], durationMs: 200_000 },
            { title: 'Unknown', artists: ['Nobody'], durationMs: 100_000 },
          ],
        },
      ],
      plays: [],
      follows: [],
      skipped: noSkips(),
    }
    const [csvId] = (await startImports(csv, {}, 'music', services)).importIds
    const record = await finished(csvId as string)
    await reviewRow(csvId as string, 0, { action: 'confirm', ref: 'knownsong01' })
    await reviewRow(csvId as string, 1, { action: 'skip' })
    const view = await getLibrary().getPlaylistView(record.playlistId as EntityId<'playlist'>)
    expect(view?.rows.map((row) => row.id)).toEqual([known.id])
    expect(await getLibrary().getImport(csvId as string)).toMatchObject({
      matched: 1,
      needsReview: 0,
    })
  })

  it('confirms every likely match at once', async () => {
    const scenario = catalogScenario([
      ['isrc', 3],
      ['no-length', 2],
    ])
    const services = fakeServices({
      youtube: fakeYouTube({ catalog: scenario.catalog }),
      autoMatch: () => false,
    })
    const [id] = (
      await startImports(parsedPlaylist('Likely', scenario.tracks), {}, 'music', services)
    ).importIds
    await finished(id as string)
    expect(await confirmLikelyMatches(id as string)).toEqual([0, 2, 4])
    expect(await getLibrary().getImport(id as string)).toMatchObject({ matched: 3, needsReview: 2 })
  })
})

describe('the history and the start', () => {
  it('records a listening history as this tab’s while it runs', async () => {
    const creep = spotifyTrack(1, 'Creep', 'Radiohead', { album: 'Pablo Honey' })
    const parsed: ParsedImport = {
      kind: 'spotify-export',
      label: 'Spotify data export',
      collections: [],
      plays: [
        {
          track: creep,
          playedAt: Date.UTC(2024, 0, 1),
          playedMs: 200_000,
          completed: true,
          skipped: false,
        },
      ],
      follows: [],
      skipped: noSkips(),
    }
    const repo = getLibrary()
    const record = repo.recordPlays.bind(repo)
    const hold = gate()
    vi.spyOn(repo, 'recordPlays').mockImplementation(async (plays) => {
      await hold.opened
      return record(plays)
    })
    const starting = startImports(parsed, {}, 'music', fakeServices())
    await waitFor(() => expect(useImportRunner.getState().recording).toHaveLength(1))
    const [historyId] = useImportRunner.getState().recording
    expect((await repo.getImport(historyId as string))?.status).toBe('running')
    hold.open()
    const started = await starting
    expect(started.historyId).toBe(historyId)
    expect(useImportRunner.getState().recording).toEqual([])
    expect((await repo.getImport(historyId as string))?.status).toBe('done')
  })

  it('reports follows it could not save, and still starts the playlists', async () => {
    const repo = getLibrary()
    vi.spyOn(repo, 'follow').mockRejectedValue(new Error('QuotaExceededError'))
    const parsed: ParsedImport = {
      ...parsedPlaylist('Mix', [spotifyTrack(1, 'Song', 'Band', { seconds: 200 })]),
      follows: [
        {
          id: formatId('spotify', 'artist', '0000000000000000000006'),
          source: 'spotify',
          name: 'Björk',
          artwork: [],
        },
      ],
    }
    const started = await startImports(parsed, {}, 'music', fakeServices())
    expect(started.importIds).toHaveLength(1)
    expect(started.failed).toEqual(['follows'])
  })

  it('says which playlists started when one could not be created', async () => {
    const repo = getLibrary()
    const create = repo.createPlaylist.bind(repo)
    let calls = 0
    vi.spyOn(repo, 'createPlaylist').mockImplementation(async (input) => {
      if (++calls === 2) throw new Error('QuotaExceededError')
      return create(input)
    })
    const parsed: ParsedImport = {
      kind: 'csv',
      label: 'x.csv',
      collections: [
        { name: 'A', rows: [{ title: 'One', artists: ['X'] }] },
        { name: 'B', rows: [{ title: 'Two', artists: ['Y'] }] },
      ],
      plays: [],
      follows: [],
      skipped: noSkips(),
    }
    const failure = await startImports(parsed, {}, 'music', fakeServices()).catch((error) => error)
    expect(failure).toBeInstanceOf(StartImportsError)
    expect((failure as StartImportsError).created).toEqual([0])
    const [first] = (failure as StartImportsError).started.importIds
    expect(await finished(first as string)).toMatchObject({ label: 'A' })
  })
})

describe('starting, stopping and failing safely', () => {
  it('stops an import paused just as its run reads it, before it ever runs', async () => {
    const repo = getLibrary()
    const read = repo.getImport.bind(repo)
    const hold = gate()
    let reading = false
    vi.spyOn(repo, 'getImport').mockImplementation(async (id) => {
      const record = await read(id)
      if (record?.status === 'pending' && !reading) {
        reading = true
        await hold.opened
      }
      return record
    })
    const services = fakeServices()
    const [id] = (
      await startImports(
        parsedPlaylist('Soon', [spotifyTrack(1, 'Song', 'Band', { seconds: 200 })]),
        {},
        'music',
        services,
      )
    ).importIds
    await waitFor(() => expect(reading).toBe(true))
    const pausing = pauseImport(id as string)
    hold.open()
    await pausing
    expect(await statusOf(id as string)).toBe('paused')
    expect(services.slots).toBe(0)
  })

  it('reads a review decision made just as the run starts, and keeps it', async () => {
    const { id, catalog, tracks } = await pausedWithReview()
    const repo = getLibrary()
    const pin = repo.pinMatch.bind(repo)
    const hold = gate()
    vi.spyOn(repo, 'pinMatch').mockImplementation(async (...args) => {
      await hold.opened
      return pin(...args)
    })
    const reviewing = reviewRow(id, 0, { action: 'confirm', ref: 'knownsong01' })
    await resumeImport(id, fakeServices({ youtube: fakeYouTube({ catalog }) }))
    hold.open()
    await reviewing
    const done = await finished(id)
    expect(done).toMatchObject({ status: 'done', matched: 2, needsReview: 0 })
    expect(await repo.getConfirmedMatch(tracks[0]?.id as EntityId<'track'>, 'music')).toMatchObject(
      { ref: 'knownsong01' },
    )
  })

  it('keeps a decision off the progress when its library change fails', async () => {
    const { id } = await pausedWithReview()
    const repo = getLibrary()
    vi.spyOn(repo, 'pinMatch').mockRejectedValue(new Error('QuotaExceededError'))
    await expect(reviewRow(id, 0, { action: 'confirm', ref: 'knownsong01' })).rejects.toThrow()
    const state = await loadImportState(id)
    expect(state?.results[0]?.review).toBeUndefined()
    expect(await repo.getImport(id)).toMatchObject({ needsReview: 1 })
  })

  it('pauses when the library can’t save, and resumes once it can', async () => {
    const { id, catalog } = await pausedWithReview()
    const repo = getLibrary()
    const spy = vi.spyOn(repo, 'recordMatch').mockRejectedValue(new Error('QuotaExceededError'))
    const services = fakeServices({ youtube: fakeYouTube({ catalog }) })
    await resumeImport(id, services)
    const paused = await finished(id)
    expect(paused.status).toBe('paused')
    expect(paused.error).toMatch(/out of space/u)
    spy.mockRestore()
    await resumeImport(id, services)
    expect(await finished(id)).toMatchObject({ status: 'done', error: '' })
  })

  it('pauses while offline, and goes on once the connection is back', async () => {
    const { id, catalog } = await pausedWithReview()
    let online = false
    const services = fakeServices({
      youtube: fakeYouTube({ catalog }),
      isOnline: () => online,
    })
    await resumeImport(id, services)
    const paused = await finished(id)
    expect(paused.status).toBe('paused')
    expect(importBlockOf(paused.state)).toBe('offline')
    online = true
    window.dispatchEvent(new Event('online'))
    await waitFor(async () => expect(await statusOf(id)).toBe('done'))
  })
})

describe('other tabs', () => {
  it('leaves an import another tab runs alone', async () => {
    const { id } = await pausedWithReview()
    setImportLockManager(fakeLocks([id]), 20)
    const services = fakeServices()
    await expect(resumeImport(id, services)).rejects.toBeInstanceOf(ImportBusyError)
    await expect(reviewRow(id, 0, { action: 'skip' })).rejects.toBeInstanceOf(ImportBusyError)
    await expect(retryFailedSongs(id, services)).rejects.toBeInstanceOf(ImportBusyError)
    expect(await statusOf(id)).toBe('paused')
  })

  it('does not run an import another tab took meanwhile', async () => {
    const { id, catalog } = await pausedWithReview()
    const locks = fakeLocks([id])
    // The other tab took it after this one looked.
    locks.reportElsewhere = false
    setImportLockManager(locks, 20)
    const services = fakeServices({ youtube: fakeYouTube({ catalog }) })
    await resumeImport(id, services)
    await waitFor(() => expect(useImportRunner.getState().activeId).toBeNull())
    expect(services.slots).toBe(0)
    expect((await loadImportState(id))?.results[1]).toBeNull()
  })
})

describe('taking decisions back', () => {
  it('unpins a confirmed match and caches the engine’s own decision again', async () => {
    const { id, tracks } = await pausedWithReview()
    const source = tracks[0]?.id as EntityId<'track'>
    await reviewRow(id, 0, { action: 'confirm', ref: 'knownsong01' })
    expect(await getLibrary().getConfirmedMatch(source, 'music')).toBeDefined()
    expect(await reopenRows(id, [0])).toBe(1)
    expect(await getLibrary().getConfirmedMatch(source, 'music')).toBeUndefined()
    expect(await getLibrary().getMatch(source, 'music')).toMatchObject({
      band: 'suggest',
      userPinned: false,
      candidate: { ref: 'knownsong01' },
    })
    expect(await getLibrary().getImport(id)).toMatchObject({ needsReview: 1 })
  })

  it('takes a song placed for a file’s row out of the playlist again', async () => {
    const known = song('knownsong01', 'Known Song', 'Known Band', { seconds: 200 })
    const csv: ParsedImport = {
      kind: 'csv',
      label: 'csv',
      collections: [{ name: 'From CSV', rows: [{ title: 'Known Song', artists: ['Known Band'] }] }],
      plays: [],
      follows: [],
      skipped: noSkips(),
    }
    const services = fakeServices({ youtube: fakeYouTube({ catalog: [known] }) })
    const [id] = (await startImports(csv, {}, 'music', services)).importIds
    const record = await finished(id as string)
    await reviewRow(id as string, 0, { action: 'confirm', ref: 'knownsong01' })
    const playlist = record.playlistId as EntityId<'playlist'>
    expect((await getLibrary().getPlaylistView(playlist))?.rows.map((row) => row.id)).toEqual([
      known.id,
    ])
    await reopenRows(id as string, [0])
    expect((await getLibrary().getPlaylistView(playlist))?.rows).toEqual([])
    expect(await getLibrary().getImport(id as string)).toMatchObject({ needsReview: 1 })
  })
})
