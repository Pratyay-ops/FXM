import { FxmError, formatId, type Track } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import type { MusicBrainzRecording, MusicBrainzRecordingRef } from '../musicbrainz'
import { rowFromTrack } from './load'
import { importReport, reportToCsv } from './report'
import { type ImportEnvironment, runImport } from './run'
import {
  applyReview,
  createImportState,
  importCounts,
  initialPlaylistTracks,
  isLikelyMatch,
  sanitizeImportState,
} from './state'
import {
  catalogScenario,
  fakeEnvironment,
  fakeSpotify,
  fakeYouTube,
  memorySink,
  song,
  spotifyTrack,
} from './testing'
import type { ImportCollection, ImportRow, ImportState } from './types'
import { YOUTUBE_IMPORT_UNAVAILABLE } from './youtube'

function setUp(
  collection: ImportCollection,
  overrides: Parameters<typeof fakeEnvironment>[0] = {},
) {
  const state = createImportState('spotify', 'music', collection)
  const sink = memorySink(initialPlaylistTracks(collection).map((track) => track.id))
  const env = fakeEnvironment(overrides)
  return { state, sink, env }
}

function run(state: ImportState, env: ImportEnvironment, sink: ReturnType<typeof memorySink>) {
  return runImport(state, env, sink, { signal: new AbortController().signal })
}

describe('runImport', () => {
  it('imports a 100-track playlist and reports every match, with no wrong auto-play', async () => {
    const scenario = catalogScenario()
    const collection: ImportCollection = {
      name: 'Road trip',
      rows: scenario.tracks.map(rowFromTrack),
    }
    const youtube = fakeYouTube({ catalog: scenario.catalog })
    const { state, sink, env } = setUp(collection, { youtube })
    await expect(run(state, env, sink)).resolves.toEqual({ status: 'done' })

    const report = importReport(state, 'Road trip')
    expect(report.totals).toMatchObject({
      rows: 100,
      pending: 0,
      ready: 0,
      matched: 80,
      review: 10,
      notFound: 10,
      failed: 0,
      isrcVerified: 70,
      noDuration: 5,
      incomplete: 0,
    })
    for (const [index, row] of report.rows.entries()) {
      const expected = scenario.expected[index]
      if (row.status === 'matched') {
        expect(row.match?.id, `row ${index + 1}`).toBe(
          formatId('ytm', 'track', expected?.ref ?? ''),
        )
      }
      if (expected?.case === 'isrc' || expected?.case === 'text') expect(row.status).toBe('matched')
      if (expected?.case === 'isrc-miss' || expected?.case === 'no-length') {
        expect(row.status).toBe('review')
        expect(row.match?.id).toBe(formatId('ytm', 'track', expected.ref ?? ''))
      }
      if (expected?.case === 'missing' || expected?.case === 'live-only') {
        expect(row.status).toBe('not-found')
      }
    }
    // Every row's decision reached the match cache, with the setting applied to the band.
    expect(sink.decisions).toHaveLength(100)
    expect(sink.decisions.filter((decision) => decision.band === 'auto')).toHaveLength(80)
    expect(sink.decisions.every((decision) => decision.mode === 'music')).toBe(true)
    // The playlist kept the Spotify tracks, in order, from the start.
    expect(sink.playlist).toEqual(scenario.tracks.map((track) => track.id))
    // Each YouTube request waited for the budget first, and the progress was saved at the end.
    expect(env.slots).toBe(youtube.requests.length)
    expect(sink.saves.at(-1)).toEqual(state)
    expect(importCounts(state)).toEqual({
      total: 100,
      done: 100,
      matched: 80,
      needsReview: 20,
      failed: 0,
    })
    expect(reportToCsv(report).trim().split('\r\n')).toHaveLength(101)
  })

  it('holds every match for review while Auto matching is off', async () => {
    const scenario = catalogScenario()
    const collection: ImportCollection = { name: 'Mix', rows: scenario.tracks.map(rowFromTrack) }
    const { state, sink, env } = setUp(collection, {
      youtube: fakeYouTube({ catalog: scenario.catalog }),
      autoMatch: false,
    })
    await run(state, env, sink)
    const report = importReport(state, 'Mix')
    expect(report.totals).toMatchObject({ matched: 0, review: 90, likely: 80, notFound: 10 })
    expect(sink.decisions.some((decision) => decision.band === 'auto')).toBe(false)
    // Confirming the likely matches pins them for their Spotify tracks.
    const likely = state.results.flatMap((result, index) => (isLikelyMatch(result) ? [index] : []))
    expect(likely).toHaveLength(80)
    const effects = likely.map((index) =>
      applyReview(
        state,
        index,
        { action: 'confirm', ref: state.results[index]?.best?.ref ?? '' },
        1,
      ),
    )
    expect(effects.every((effect) => effect.type === 'pin')).toBe(true)
    expect(importReport(state, 'Mix').totals).toMatchObject({ confirmed: 80, review: 10 })
  })

  it('resumes from its saved progress where it stopped, without searching a row twice', async () => {
    const scenario = catalogScenario([
      ['isrc', 20],
      ['text', 5],
    ])
    const collection: ImportCollection = { name: 'Mix', rows: scenario.tracks.map(rowFromTrack) }
    const youtube = fakeYouTube({ catalog: scenario.catalog })
    const controller = new AbortController()
    const { state, sink, env } = setUp(collection, { youtube })
    const stoppingEnv: ImportEnvironment = {
      ...env,
      async waitForBulkSlot(signal) {
        if (youtube.requests.length >= 10) controller.abort(new Error('paused'))
        signal.throwIfAborted()
      },
    }
    await expect(
      runImport(state, stoppingEnv, sink, { signal: controller.signal }),
    ).resolves.toEqual({
      status: 'stopped',
    })
    const saved = sink.saves.at(-1) as ImportState
    const done = importCounts(saved).done
    expect(done).toBeGreaterThan(0)
    expect(done).toBeLessThan(25)
    const requestsBefore = youtube.requests.length

    // A reload: the progress comes back from storage, and a new run picks it up.
    const restored = sanitizeImportState(JSON.parse(JSON.stringify(saved)))
    expect(restored).not.toBeNull()
    const resumed = restored as ImportState
    await expect(run(resumed, env, sink)).resolves.toEqual({ status: 'done' })
    expect(importCounts(resumed)).toMatchObject({ done: 25, matched: 25 })
    const repeated = youtube.requests
      .slice(requestsBefore)
      .filter((request) => youtube.requests.slice(0, requestsBefore).includes(request))
    // Only the row that was cut off mid-search may search again.
    expect(new Set(repeated).size).toBeLessThanOrEqual(2)
  })

  it('places songs for rows without a catalog track in order, and leaves guesses for review', async () => {
    const a = song('aaaaaaaaaaa', 'Alpha Song', 'Alpha Band', { seconds: 200 })
    const c = song('ccccccccccc', 'Gamma Song', 'Gamma Band', { seconds: 210 })
    const d = song('ddddddddddd', 'Delta Song', 'Delta Band', { seconds: 220 })
    const rows: ImportRow[] = [
      { title: 'Alpha Song', artists: ['Alpha Band'], durationMs: 200_000 },
      { title: 'Delta Song', artists: ['Delta Band'] },
      { title: 'Unknown Thing', artists: ['Nobody'], durationMs: 100_000 },
      { title: 'Gamma Song', artists: ['Gamma Band'], durationMs: 211_000 },
    ]
    const { state, sink, env } = setUp(
      { name: 'From CSV', rows },
      {
        youtube: fakeYouTube({ catalog: [a, c, d] }),
      },
    )
    await run(state, env, sink)
    expect(state.results.map((result) => result?.outcome)).toEqual([
      'matched',
      'review',
      'not-found',
      'matched',
    ])
    expect(sink.playlist).toEqual([a.id, c.id])
    expect(sink.decisions).toEqual([])
    const effect = applyReview(state, 1, { action: 'confirm', ref: 'ddddddddddd' }, 5)
    expect(effect).toMatchObject({ type: 'place', index: 1, before: c.id, track: { id: d.id } })
    expect(state.results[1]?.playlistTrackId).toBe(d.id)
    expect(applyReview(state, 2, { action: 'skip' }, 6)).toEqual({ type: 'none' })
    expect(importCounts(state)).toMatchObject({ matched: 3, needsReview: 0 })
  })

  it('loads the tracks rows only link to, and puts them in their place', async () => {
    const linked = song('lllllllllll', 'Linked Song', 'Linked Band', { seconds: 180 })
    const rows: ImportRow[] = [
      { title: '', artists: [], trackId: linked.id },
      { title: '', artists: [], trackId: formatId('spotify', 'track', '0000000000000000000009') },
      { title: 'Linked Song', artists: ['Linked Band'], durationMs: 180_000 },
    ]
    const { state, sink, env } = setUp(
      { name: 'M3U', rows },
      {
        youtube: fakeYouTube({ catalog: [linked] }),
      },
    )
    await run(state, env, sink)
    expect(state.rows[0]).toMatchObject({ title: 'Linked Song', kind: 'song', trackId: linked.id })
    expect(state.results[0]).toMatchObject({ outcome: 'ready', playlistTrackId: linked.id })
    expect(state.results[1]).toMatchObject({ outcome: 'failed' })
    expect(sink.tracks.get(linked.id)).toMatchObject({ title: 'Linked Song' })
    // The third row matches the same song, which the playlist already holds once.
    expect(state.results[2]).toMatchObject({ outcome: 'matched', playlistTrackId: linked.id })
    expect(sink.playlist).toEqual([linked.id])
  })

  it('maps official videos to songs in Music mode, and keeps every item in Music + Video', async () => {
    const theSong = song('songsongson', 'Bright Lights', 'Neon Band', { seconds: 200 })
    const video = song('videovideov', 'Neon Band - Bright Lights (Official Video)', 'Neon Band', {
      kind: 'music-video',
      seconds: 215,
    })
    const upload = song('uploadxxxxx', 'bright lights cover', 'Some Fan', {
      kind: 'video',
      seconds: 190,
      source: 'yt',
    })
    const collection: ImportCollection = {
      name: 'Videos',
      rows: [theSong, video, upload].map(rowFromTrack),
    }
    const music = setUp(collection, { youtube: fakeYouTube({ catalog: [theSong] }) })
    await run(music.state, music.env, music.sink)
    expect(music.state.results.map((result) => result?.outcome)).toEqual([
      'ready',
      'matched',
      'not-found',
    ])
    expect(music.state.results[1]?.best?.ref).toBe('songsongson')
    // The plain video is hidden in Music mode: no decision is cached for it, it stays itself.
    expect(music.sink.decisions.map((decision) => decision.sourceTrackId)).toEqual([video.id])
    expect(music.state.results[2]?.playlistTrackId).toBe(upload.id)

    const all = setUp(collection, { youtube: fakeYouTube({ catalog: [theSong] }), mode: 'all' })
    all.state.mode = 'all'
    await run(all.state, all.env, all.sink)
    expect(all.state.results.map((result) => result?.outcome)).toEqual(['ready', 'ready', 'ready'])
    expect(all.env.slots).toBe(0)
  })

  it('waits for the budget, retries after a bot check, and goes on without a page that keeps failing', async () => {
    const tracks = [
      spotifyTrack(1, 'First Song', 'First Band', { seconds: 200, isrc: 'QZTST2600001' }),
    ]
    const catalog = [
      song('first000001', 'First Song', 'First Band', { seconds: 200, isrc: 'QZTST2600001' }),
    ]
    const rows = tracks.map(rowFromTrack)

    const botChecked = setUp(
      { name: 'A', rows },
      {
        youtube: fakeYouTube({
          catalog,
          failWith: { error: new FxmError('BotCheck', 'unusual traffic'), times: 2 },
        }),
      },
    )
    await run(botChecked.state, botChecked.env, botChecked.sink)
    expect(botChecked.state.results[0]?.outcome).toBe('matched')
    expect(botChecked.env.reported).toHaveLength(2)
    expect(botChecked.env.waits.filter((ms) => ms >= 1000)).toHaveLength(2)

    const failing = setUp(
      { name: 'C', rows },
      {
        youtube: fakeYouTube({ catalog, failWith: { error: new FxmError('Parse', 'odd page') } }),
      },
    )
    await run(failing.state, failing.env, failing.sink)
    // Nothing could be fetched, so nothing is known: the row failed, and was never cached.
    expect(failing.state.results[0]).toMatchObject({ outcome: 'failed', incomplete: true })
    expect(failing.sink.decisions).toEqual([])
  })

  it('stops as offline when the network keeps failing, keeping the row waiting', async () => {
    const tracks = [spotifyTrack(1, 'First Song', 'First Band', { seconds: 200 })]
    const catalog = [song('first000001', 'First Song', 'First Band', { seconds: 200 })]
    const offline = setUp(
      { name: 'B', rows: tracks.map(rowFromTrack) },
      {
        youtube: fakeYouTube({ catalog, failWith: { error: new FxmError('Network', 'offline') } }),
      },
    )
    await expect(run(offline.state, offline.env, offline.sink)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'offline',
    })
    // A short drop is ridden out first: five more tries, further and further apart.
    expect(offline.env.waits).toEqual([2000, 4000, 8000, 16_000, 30_000])
    expect(offline.state.results[0]).toBeNull()
    expect(offline.state.blocked).toBe('offline')
    expect(offline.sink.saves.at(-1)?.blocked).toBe('offline')
    expect(offline.sink.decisions).toEqual([])

    // Back online, the next run takes the row up again and forgets why it stopped.
    const back = { ...offline.env, youtube: fakeYouTube({ catalog }) }
    await expect(run(offline.state, back, offline.sink)).resolves.toEqual({ status: 'done' })
    expect(offline.state.results[0]).toMatchObject({ outcome: 'matched' })
    expect(offline.state.blocked).toBeUndefined()
  })

  it('stops at once while the device says it is offline', async () => {
    const tracks = [spotifyTrack(1, 'First Song', 'First Band', { seconds: 200 })]
    const youtube = fakeYouTube({ catalog: [] })
    const { state, sink, env } = setUp(
      { name: 'O', rows: tracks.map(rowFromTrack) },
      { youtube, isOnline: () => false },
    )
    await expect(run(state, env, sink)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'offline',
    })
    expect(youtube.requests).toEqual([])
    expect(state.results[0]).toBeNull()
  })

  it('reads a search that finds nothing as an empty page, and caches the decision', async () => {
    const tracks = [spotifyTrack(1, 'Lonely Song', 'Lonely Band', { seconds: 200 })]
    const youtube = fakeYouTube({
      catalog: [],
      failWith: { error: new FxmError('NotFound', 'no results') },
    })
    const { state, sink, env } = setUp({ name: 'N', rows: tracks.map(rowFromTrack) }, { youtube })
    await run(state, env, sink)
    expect(state.results[0]).toMatchObject({ outcome: 'not-found' })
    expect(state.results[0]?.incomplete).toBeUndefined()
    expect(sink.decisions).toHaveLength(1)
  })

  it('saves its progress at most every 20 seconds, and keeps little of the rows that play', async () => {
    const scenario = catalogScenario([
      ['isrc', 30],
      ['isrc-miss', 4],
    ])
    const collection: ImportCollection = { name: 'Mix', rows: scenario.tracks.map(rowFromTrack) }
    const youtube = fakeYouTube({ catalog: scenario.catalog })
    const { state, sink, env } = setUp(collection, { youtube })
    let clock = Date.UTC(2026, 9, 26, 12)
    const paced: ImportEnvironment = {
      ...env,
      now: () => clock,
      // The budget hands out a bulk slot every 5 seconds.
      async waitForBulkSlot(signal) {
        signal.throwIfAborted()
        clock += 5000
      },
    }
    await run(state, paced, sink)
    const seconds = youtube.requests.length * 5
    expect(sink.saves.length).toBeLessThanOrEqual(Math.ceil(seconds / 20) + 1)
    expect(sink.saves.length).toBeGreaterThan(1)
    expect(sink.saves.length).toBeLessThan(state.rows.length)
    // A matched row keeps its best candidate only; a row to review keeps its alternatives.
    const matched = state.results.filter((result) => result?.outcome === 'matched')
    expect(matched).toHaveLength(30)
    expect(matched.every((result) => !result?.alternatives && !result?.extras)).toBe(true)
    expect(matched.every((result) => result?.best !== undefined)).toBe(true)
  })

  it('matches a video Music mode hides like a row without a track, and places its song after it', async () => {
    const theSong = song('songsongson', 'Bright Lights', 'Neon Band', { seconds: 200 })
    const upload = song('uploadxxxxx', 'Bright Lights', 'Neon Band', {
      kind: 'video',
      seconds: 200,
      source: 'yt',
    })
    const next = song('nextsongxxx', 'Other Song', 'Other Band', { seconds: 180 })
    const collection: ImportCollection = { name: 'V', rows: [upload, next].map(rowFromTrack) }
    const { state, sink, env } = setUp(collection, {
      youtube: fakeYouTube({ catalog: [theSong, next] }),
    })
    await run(state, env, sink)
    expect(state.results[0]).toMatchObject({ outcome: 'matched', playlistTrackId: theSong.id })
    expect(sink.playlist).toEqual([upload.id, theSong.id, next.id])
    expect(sink.decisions).toEqual([])
  })

  it('stops as blocked while YouTube Music cannot be reached, keeping the waiting rows', async () => {
    const ready = song('readyreadyr', 'Ready Song', 'Ready Band', { seconds: 200 })
    const collection: ImportCollection = {
      name: 'Blocked',
      rows: [
        rowFromTrack(ready),
        rowFromTrack(spotifyTrack(2, 'Waiting Song', 'Waiting Band', { seconds: 190 })),
      ],
    }
    const { state, sink, env } = setUp(collection, { youtube: YOUTUBE_IMPORT_UNAVAILABLE })
    const end = await run(state, env, sink)
    expect(end).toMatchObject({ status: 'blocked', reason: 'unsupported' })
    expect(state.results[0]).toMatchObject({ outcome: 'ready' })
    expect(state.results[1]).toBeNull()
    expect(sink.saves.at(-1)?.results[0]).toMatchObject({ outcome: 'ready' })
    expect(sink.saves.at(-1)?.blocked).toBe('unsupported')
  })

  it('looks Spotify rows up on Spotify one second apart, and falls back to MusicBrainz', async () => {
    const tracks = [1, 2, 3].map((n) =>
      spotifyTrack(n, `Song ${n}`, `Band ${n}`, { seconds: 200 + n, isrc: `QZTST260000${n}` }),
    )
    const rows = tracks.map((track) => {
      const { isrc: _isrc, ...withoutIsrc } = rowFromTrack(track)
      return withoutIsrc
    })
    const catalog = tracks.map((track, index) =>
      song(`song0000${index + 1}00`, track.title, track.artists[0]?.name ?? '', {
        seconds: (track.durationMs ?? 0) / 1000,
        ...(track.isrc === undefined ? {} : { isrc: track.isrc }),
      }),
    )
    const spotify = fakeSpotify({ tracks })
    const { state, sink, env } = setUp(
      { name: 'S', rows },
      { youtube: fakeYouTube({ catalog }), spotify },
    )
    await run(state, env, sink)
    expect(spotify.calls.filter((call) => call.startsWith('details'))).toHaveLength(3)
    expect(state.results.map((result) => [result?.lookup, result?.isrcOrigin])).toEqual([
      ['spotify', 'catalog'],
      ['spotify', 'catalog'],
      ['spotify', 'catalog'],
    ])
    expect(env.waits.filter((ms) => ms === 1000).length).toBeGreaterThanOrEqual(1)

    const failing = fakeSpotify({
      tracks,
      failWith: new FxmError('RateLimited', 'paused', { retryAfterMs: 60_000 }),
    })
    const fallback = setUp(
      { name: 'S', rows },
      {
        youtube: fakeYouTube({ catalog }),
        spotify: failing,
        musicBrainz: {
          lookupUrls: async () => new Map(),
          getRecordings: async () => new Map(),
        },
      },
    )
    await run(fallback.state, fallback.env, fallback.sink)
    // One failed call pauses Spotify for the rest of the run.
    expect(failing.calls).toHaveLength(1)
  })

  it('marks a row incomplete when MusicBrainz is busy, so Retry looks it up again', async () => {
    const tracks = [spotifyTrack(1, 'Busy Song', 'Busy Band')]
    const rows = tracks.map((track) => ({
      title: track.title,
      artists: ['Busy Band'],
      trackId: track.id,
    }))
    const catalog = [song('busysong001', 'Busy Song', 'Busy Band', { seconds: 200 })]
    const { state, sink, env } = setUp(
      { name: 'Busy', rows },
      {
        youtube: fakeYouTube({ catalog }),
        musicBrainz: {
          lookupUrls: async () => {
            throw new FxmError('RateLimited', 'slow down')
          },
          getRecordings: async () => new Map(),
        },
      },
    )
    await run(state, env, sink)
    expect(state.results[0]).toMatchObject({ outcome: 'review', incomplete: true })
    expect(state.lookups).toEqual({})
    expect(sink.decisions).toEqual([])
  })

  it('looks data-export rows up through MusicBrainz in one batch, which lets them auto-play', async () => {
    const tracks = [1, 2, 3, 4].map((n) => spotifyTrack(n, `Export ${n}`, `Exporter ${n}`))
    const rows = tracks.map((track) => ({
      title: track.title,
      artists: [track.artists[0]?.name ?? ''],
      trackId: track.id,
    }))
    const catalog = tracks.map((track, index) =>
      song(`mbmatch${index + 1}000`, track.title, track.artists[0]?.name ?? '', {
        seconds: 200,
        isrc: `QZTST260001${index + 1}`,
      }),
    )
    const urlCalls: string[][] = []
    const musicBrainz = {
      async lookupUrls(urls: readonly string[]) {
        urlCalls.push([...urls])
        return new Map<string, MusicBrainzRecordingRef[]>(
          urls
            .slice(0, 3)
            .map((url, index) => [
              url,
              [{ id: `mbid-${index}`, title: 'x', lengthMs: 200_500, video: false }],
            ]),
        )
      },
      async getRecordings(ids: readonly string[]) {
        return new Map<string, MusicBrainzRecording>(
          ids.map((id) => {
            const index = Number(id.slice('mbid-'.length))
            return [
              id,
              {
                id,
                title: 'x',
                lengthMs: 200_500,
                video: false,
                credits: [],
                artists: [],
                isrcs: index === 2 ? [] : [`QZTST260001${index + 1}`],
              },
            ]
          }),
        )
      },
    }
    const { state, sink, env } = setUp(
      { name: 'Export', rows },
      {
        youtube: fakeYouTube({ catalog }),
        musicBrainz,
      },
    )
    await run(state, env, sink)
    expect(urlCalls).toHaveLength(1)
    expect(urlCalls[0]).toHaveLength(4)
    expect(
      state.results.map((result) => [
        result?.outcome,
        result?.lookup,
        result?.isrcOrigin,
        result?.noDuration,
      ]),
    ).toEqual([
      ['matched', 'musicbrainz', 'musicbrainz-exact', undefined],
      ['matched', 'musicbrainz', 'musicbrainz-exact', undefined],
      // MusicBrainz knew the length but no ISRC: a text match with a length.
      ['matched', 'musicbrainz', undefined, undefined],
      // MusicBrainz knew nothing: no-duration mode, at most Suggest.
      ['review', undefined, undefined, true],
    ])
  })

  it('reuses the match cache instead of searching again', async () => {
    const track = spotifyTrack(1, 'Cached Song', 'Cached Band', { seconds: 200 })
    const { state, sink, env } = setUp({ name: 'C', rows: [rowFromTrack(track)] })
    const pinned = {
      source: 'ytm' as const,
      ref: 'pinnedpinne',
      kind: 'song' as const,
      title: 'Cached Song',
      artists: ['Cached Band'],
      confidence: 0.7,
      evidence: [],
    }
    sink.cache.set(`${track.id}|music`, {
      band: 'suggest',
      candidate: pinned,
      alternatives: [],
      evidence: ['pinned by the user'],
      userPinned: true,
    })
    await run(state, env, sink)
    expect(state.results[0]).toMatchObject({
      outcome: 'matched',
      cached: true,
      review: { action: 'confirmed' },
    })
    expect(env.slots).toBe(0)
    expect(sink.decisions).toEqual([])
  })

  it('stops with the library’s error when it cannot save', async () => {
    const track: Track = spotifyTrack(1, 'Song', 'Band', { seconds: 200 })
    const { state, sink, env } = setUp(
      { name: 'X', rows: [rowFromTrack(track)] },
      {
        youtube: fakeYouTube({ catalog: [] }),
      },
    )
    const full = new Error('QuotaExceededError')
    sink.recordMatch = async () => {
      throw full
    }
    await expect(run(state, env, sink)).rejects.toBe(full)
  })
})
