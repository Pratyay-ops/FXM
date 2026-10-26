import { formatId, type Track } from '@fxm/core'
import { Player, StreamLifecycle } from '@fxm/player'
import {
  FakeEngine,
  FakeStreamSource,
  testCandidate,
  testContext,
  testTrack,
} from '@fxm/player/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createOfflineStore, offlineIds, offlineStream } from './offline'
import { createMemoryDownloadStorage } from './storage'
import { createMemoryDownloadStore } from './store'
import { mediaUrl, setup } from './test-harness'
import { downloadCandidate } from './testing/fake-resolver'
import { type DownloadRecord, downloadId, fileFormatOf, newDownloadRecord } from './types'

const players: Player[] = []

afterEach(() => {
  for (const player of players.splice(0)) player.destroy()
})

/** A completed download of `track` in `file`. */
function completed(
  track: Track,
  file: string,
  overrides: Partial<DownloadRecord> = {},
): DownloadRecord {
  return {
    ...newDownloadRecord(track, 1),
    status: 'completed',
    completedAt: 2,
    bytesDone: 3,
    bytesTotal: 3,
    file,
    candidate: downloadCandidate(track),
    format: fileFormatOf({
      codec: 'aac',
      container: 'm4a',
      media: 'audio',
      tier: 'high',
      bitrateKbps: 130,
    }),
    ...overrides,
  }
}

function stored(records: DownloadRecord[]) {
  const store = createMemoryDownloadStore(records)
  const storage = createMemoryDownloadStorage()
  for (const record of records) {
    if (record.file !== undefined) storage.put(record.file, new Uint8Array([1, 2, 3]))
  }
  return { store, storage, offline: createOfflineStore({ store, storage }) }
}

describe('the offline store', () => {
  it('finds a completed download as a verified stream of the stored file', async () => {
    const track = testTrack('a')
    const { offline } = stored([completed(track, 'file-a')])
    const stream = await offline.find(track, testContext('full'))
    expect(stream).toEqual({
      url: 'memory:file-a',
      codec: 'aac',
      container: 'm4a',
      media: 'audio',
      tier: 'high',
      bitrateKbps: 130,
      protocol: 'progressive',
      ipBound: false,
      fullLength: 'verified',
    })
    // Whichever YouTube prefix names the track, and offline too.
    const sameVideo = testTrack('a', { id: formatId('yt', 'track', 'a'), source: 'yt' })
    expect((await offline.find(sameVideo, testContext('free')))?.url).toBe('memory:file-a')
  })

  it('ignores downloads that are not complete, and files that are gone', async () => {
    const tracks = ['a', 'b', 'c', 'd'].map((name) => testTrack(name))
    const [a, b, c, d] = tracks as [Track, Track, Track, Track]
    const { offline, storage } = stored([
      { ...completed(a, 'file-a'), status: 'paused' },
      { ...completed(b, 'file-b'), status: 'removing' },
      completed(c, 'file-c'),
    ])
    await storage.remove('file-c')
    for (const track of [a, b, c, d]) {
      expect(await offline.find(track, testContext('full'))).toBeUndefined()
    }
  })

  it('ignores corrupt records', async () => {
    const track = testTrack('a')
    const record = completed(track, 'file-a')
    const { format: _format, ...noFormat } = record
    for (const broken of [{ ...record, bytesDone: -1 }, noFormat]) {
      const { offline } = stored([broken as DownloadRecord])
      expect(await offline.find(track, testContext('full'))).toBeUndefined()
    }
    const { candidate: _candidate, ...noCandidate } = record
    const { offline } = stored([noCandidate])
    expect(await offline.find(track, testContext('full'))).toBeUndefined()
  })

  it("follows the catalog mode: a video's own audio never plays in Music mode", async () => {
    const video = testTrack('v', { kind: 'music-video' })
    const record = completed(video, 'file-v', {
      candidate: testCandidate('v', { kind: 'music-video' }),
    })
    const { offline } = stored([record])
    expect(await offline.find(video, testContext('full', { mode: 'music' }))).toBeUndefined()
    expect(await offline.find(video, testContext('full', { mode: 'all' }))).toBeDefined()
  })

  it('plays a downloaded song for its music video in Music mode', async () => {
    const song = testTrack('song')
    const video = testTrack('v', { kind: 'music-video', songId: song.id })
    const { offline } = stored([completed(song, 'file-song')])
    expect(offlineIds(video, 'music')).toEqual([downloadId(video), downloadId(song)])
    expect(offlineIds(video, 'all')).toEqual([downloadId(video)])
    expect((await offline.find(video, testContext('full', { mode: 'music' })))?.url).toBe(
      'memory:file-song',
    )
    expect(await offline.find(video, testContext('full', { mode: 'all' }))).toBeUndefined()
  })

  it('types the URL of a file whose format has no MIME type as plain bytes', async () => {
    const track = testTrack('a')
    // MP3 in a WebM container: a mislabelled source, which no MIME type describes.
    const record = completed(track, 'file-a', {
      format: { codec: 'mp3', container: 'webm', media: 'audio', tier: 'high' },
    })
    const store = createMemoryDownloadStore([record])
    const types: string[] = []
    const offline = createOfflineStore({
      store,
      storage: {
        playbackUrl: async (_file, type) => {
          types.push(type)
          return 'blob:x'
        },
      },
    })
    expect((await offline.find(track, testContext('full')))?.url).toBe('blob:x')
    expect(types).toEqual(['application/octet-stream'])
  })

  it('needs a format to describe the stream', () => {
    const { format: _format, ...record } = completed(testTrack('a'), 'file-a')
    expect(offlineStream(record, 'memory:x')).toBeUndefined()
  })
})

describe('offline playback through the player', () => {
  function playerWith(offline: ReturnType<typeof createOfflineStore>, tier: 'full' | 'free') {
    const youtube = new FakeStreamSource({ now: () => Date.now() })
    const lifecycle = new StreamLifecycle({
      sources: [youtube],
      context: () => testContext(tier),
      offline,
    })
    const engine = new FakeEngine()
    const player = new Player({ engine, resolver: lifecycle })
    lifecycle.attach(player)
    players.push(player)
    return { player, engine, youtube }
  }

  it('plays a download before resolving anything, also without a network', async () => {
    const a = testTrack('a')
    const { offline } = stored([completed(a, 'file-a')])
    const { player, engine, youtube } = playerWith(offline, 'free')
    await player.setQueue([a])
    expect(engine.loadedUrls).toEqual(['memory:file-a'])
    expect(player.getState().stream).toMatchObject({ fullLength: 'verified', ipBound: false })
    expect(youtube.calls).toHaveLength(0)
  })

  it('streams the track when its download fails to play', async () => {
    const a = testTrack('a')
    const { offline } = stored([completed(a, 'file-a')])
    const { player, engine, youtube } = playerWith(offline, 'full')
    await player.setQueue([a])
    engine.fail('decode')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(engine.loadedUrls).toEqual(['memory:file-a', 'https://media.test/a/251?n=1'])
    expect(youtube.log).toEqual(['a:top'])
  })

  it('plays what the download manager downloaded', async () => {
    const h = setup()
    const a = testTrack('a')
    const bytes = h.serve(a, 3000)
    await h.manager.start()
    await h.manager.enqueue(a)
    await h.manager.idle()
    const offline = createOfflineStore({ store: h.store, storage: h.storage })
    const { player, engine } = playerWith(offline, 'free')
    await player.setQueue([a])
    expect(engine.loadedUrls).toEqual(['memory:file-1'])
    expect(h.storage.bytes('file-1')).toEqual(bytes)
    expect(h.server.requests.every((request) => request.url === mediaUrl(a, 1))).toBe(true)
  })
})
