import { type EntityId, formatId } from '@fxm/core'
import {
  noSkips,
  type ParsedImport,
  rowFromTrack,
  YOUTUBE_IMPORT_UNAVAILABLE,
} from '@fxm/sources/import'
import { catalogScenario, fakeYouTube, song, spotifyTrack } from '@fxm/sources/import/testing'
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getLibrary } from '../../db/repo'
import {
  confirmLikelyMatches,
  HISTORY_IMPORT_KIND,
  loadImportState,
  pauseImport,
  resetImportRunner,
  resumeImport,
  reviewRow,
  startImports,
} from './runner'
import { fakeServices } from './testing'

afterEach(() => resetImportRunner())

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
    expect(record.error).toMatch(/FXM Connect/u)
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
    expect(await confirmLikelyMatches(id as string)).toBe(3)
    expect(await getLibrary().getImport(id as string)).toMatchObject({ matched: 3, needsReview: 2 })
  })
})
