import { FxmError, formatId, playbackProblemError, type Track } from '@fxm/core'
import { testCandidate } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadLane } from './availability'
import { DownloadManager } from './manager'
import { NoDownloadableStreamError } from './resolver'
import { createMemoryDownloadStorage, type DownloadStorage } from './storage'
import { createMemoryDownloadStore, type DownloadStore } from './store'
import { archiveFile, CHUNK, mediaUrl, setup, song } from './test-harness'
import { downloadCandidate, downloadStream } from './testing/fake-resolver'
import { testBytes } from './testing/fake-server'
import { type DownloadRecord, downloadId, fileFormatOf, newDownloadRecord } from './types'

afterEach(() => {
  vi.useRealTimers()
})

/** The ranges asked for a file of `size` bytes from `from`, in the tests' chunks. */
function ranges(from: number, size: number): string[] {
  const list: string[] = []
  for (let at = from; at < size; at += CHUNK) {
    list.push(`bytes=${at}-${Math.min(at + CHUNK, size) - 1}`)
  }
  return list
}

describe('downloading', () => {
  it('downloads a queued track into storage, one range at a time', async () => {
    const h = setup()
    const track = song('a')
    const bytes = h.serve(track, 5000)
    const completed: DownloadRecord[] = []
    h.manager.on('completed', (record) => completed.push(record))
    await h.manager.start()
    const queued = await h.manager.enqueue(track)
    expect(queued).toMatchObject({ id: downloadId(track), status: 'queued', bytesDone: 0 })
    await h.manager.idle()
    const record = await h.manager.get(track)
    expect(record).toMatchObject({
      status: 'completed',
      bytesDone: 5000,
      bytesTotal: 5000,
      file: 'file-1',
      candidate: { source: 'ytm', ref: 'a' },
      format: { codec: 'opus', container: 'webm', media: 'audio', tier: 'high' },
      attempts: 0,
    })
    expect(record?.completedAt).toBeTypeOf('number')
    expect(h.storage.bytes('file-1')).toEqual(bytes)
    expect(h.storage.openFiles.size).toBe(0)
    expect(h.server.rangesFor(mediaUrl(track, 1))).toEqual(ranges(0, 5000))
    expect(completed.map((done) => done.id)).toEqual([record?.id])
    expect(h.resolver.reasonsFor(track)).toEqual(['start'])
  })

  it('runs two downloads at a time, oldest first', async () => {
    const h = setup()
    const [a, b, c] = ['a', 'b', 'c'].map(song) as [
      ReturnType<typeof song>,
      ReturnType<typeof song>,
      ReturnType<typeof song>,
    ]
    for (const track of [a, b, c]) h.serve(track, 3000)
    h.server.rule(mediaUrl(a, 1), { holdAt: 500 })
    h.server.rule(mediaUrl(b, 2), { holdAt: 500 })
    await h.manager.start()
    expect(await h.manager.enqueueAll([a, b, c])).toEqual({ queued: 3, present: 0, skipped: 0 })
    await vi.waitFor(() => expect(h.server.requests).toHaveLength(2))
    expect((await h.record(a))?.status).toBe('downloading')
    expect((await h.record(b))?.status).toBe('downloading')
    expect((await h.record(c))?.status).toBe('queued')
    h.server.release(mediaUrl(a, 1))
    await vi.waitFor(async () => expect((await h.record(c))?.status).toBe('completed'))
    expect((await h.record(b))?.status).toBe('downloading')
    h.server.release(mediaUrl(b, 2))
    await h.manager.idle()
    expect((await h.manager.list()).map((record) => [record.track.title, record.status])).toEqual([
      ['a', 'completed'],
      ['b', 'completed'],
      ['c', 'completed'],
    ])
    expect(h.resolver.calls.map((call) => call.track.title)).toEqual(['a', 'b', 'c'])
  })

  it('saves progress while it downloads', async () => {
    const h = setup({ progressIntervalMs: 0 })
    const track = song('a')
    h.serve(track, 5000)
    h.server.rule(mediaUrl(track, 1), { holdAt: 2500 })
    await h.manager.start()
    await h.manager.enqueue(track)
    await vi.waitFor(async () => expect((await h.record(track))?.bytesDone).toBe(2048))
    expect(await h.record(track)).toMatchObject({ status: 'downloading', bytesTotal: 5000 })
    h.server.release(mediaUrl(track, 1))
    await h.manager.idle()
    expect((await h.record(track))?.status).toBe('completed')
  })

  it('pauses a download and resumes it where it stopped', async () => {
    const h = setup()
    const track = song('a')
    const bytes = h.serve(track, 5000)
    h.server.rule(mediaUrl(track, 1), { holdAt: 2600 })
    await h.manager.start()
    await h.manager.enqueue(track)
    await vi.waitFor(() =>
      expect(h.server.rangesFor(mediaUrl(track, 1))).toContain('bytes=2048-3071'),
    )
    expect((await h.manager.pause(downloadId(track)))?.status).toBe('paused')
    await h.manager.idle()
    const paused = await h.record(track)
    expect(paused).toMatchObject({ status: 'paused', bytesDone: 2600, bytesTotal: 5000 })
    expect(h.storage.bytes('file-1')).toEqual(bytes.slice(0, 2600))
    // A pause of a paused download changes nothing.
    expect(await h.manager.pause(downloadId(track))).toEqual(paused)

    await h.manager.resume(downloadId(track))
    await h.manager.idle()
    expect((await h.record(track))?.status).toBe('completed')
    expect(h.storage.bytes('file-1')).toEqual(bytes)
    expect(h.server.rangesFor(mediaUrl(track, 2))).toEqual(ranges(2600, 5000))
    expect(h.resolver.reasonsFor(track)).toEqual(['start', 'resume'])
    expect(h.resolver.calls[1]?.request).toMatchObject({
      candidate: { ref: 'a' },
      format: { codec: 'opus', container: 'webm' },
    })
  })

  it('stops at once when another tab pauses the download', async () => {
    const h = setup()
    const track = song('a')
    h.serve(track, 5000)
    h.server.rule(mediaUrl(track, 1), { holdAt: 1500 })
    await h.manager.start()
    // Another tab has its own manager on the same store, and doesn't run the queue.
    const other = new DownloadManager({
      store: h.store,
      storage: createMemoryDownloadStorage(),
      resolver: h.resolver,
      context: h.context,
    })
    await other.enqueue(track)
    await vi.waitFor(() => expect(h.server.requests).toHaveLength(2))
    await other.pause(downloadId(track))
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'paused', bytesDone: 1500 })
    expect(h.storage.openFiles.size).toBe(0)
    expect(other.running).toBe(false)
  })

  it('cancels a running download and deletes its file', async () => {
    const h = setup()
    const track = song('a')
    h.serve(track, 5000)
    h.server.rule(mediaUrl(track, 1), { holdAt: 1500 })
    const removed: DownloadRecord[] = []
    h.manager.on('removed', (record) => removed.push(record))
    await h.manager.start()
    await h.manager.enqueue(track)
    await vi.waitFor(() => expect(h.server.requests).toHaveLength(2))
    expect((await h.manager.remove(downloadId(track)))?.status).toBe('downloading')
    expect(await h.manager.get(track)).toBeUndefined()
    expect(await h.manager.list()).toEqual([])
    await h.manager.idle()
    expect(await h.record(track)).toBeUndefined()
    expect(h.storage.bytes('file-1')).toBeUndefined()
    expect(removed.map((record) => record.track.title)).toEqual(['a'])
    expect(await h.manager.remove(downloadId(track))).toBeUndefined()
  })

  it('leaves a removal to the manager that runs the queue', async () => {
    const h = setup()
    const track = song('a')
    await h.manager.enqueue(track)
    await h.manager.remove(downloadId(track))
    expect((await h.record(track))?.status).toBe('removing')
    await h.manager.start()
    await h.manager.idle()
    expect(await h.record(track)).toBeUndefined()
    expect(h.resolver.calls).toHaveLength(0)
  })

  it('deletes a completed download and its file', async () => {
    const h = setup()
    const track = song('a')
    h.serve(track, 2000)
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(h.storage.bytes('file-1')).toHaveLength(2000)
    const removed = vi.fn()
    h.manager.on('removed', removed)
    await h.manager.remove(downloadId(track))
    await h.manager.idle()
    expect(h.storage.bytes('file-1')).toBeUndefined()
    expect(removed).toHaveBeenCalledWith(expect.objectContaining({ status: 'removing' }))
    // Downloading it again starts from nothing.
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'completed', file: 'file-2' })
  })

  it('takes a download that is gone back up when it is queued again', async () => {
    const h = setup()
    const track = song('a')
    h.serve(track, 2000)
    await h.manager.enqueue(track)
    await h.manager.remove(downloadId(track))
    // Queued again before any manager deleted it.
    expect((await h.manager.enqueue(track)).status).toBe('queued')
    await h.manager.start()
    await h.manager.idle()
    expect((await h.record(track))?.status).toBe('completed')
  })

  it('keeps a download that is completed or on its way when queued again', async () => {
    const h = setup()
    const track = song('a')
    h.serve(track, 2000)
    const first = await h.manager.enqueue(track)
    expect(await h.manager.enqueue(track)).toEqual(first)
    await h.manager.start()
    await h.manager.idle()
    const done = await h.record(track)
    expect(await h.manager.enqueue(track)).toEqual(done)
    expect(h.resolver.calls).toHaveLength(1)
  })
})

describe('failures', () => {
  it('resolves afresh when the URL is refused, and continues from the stored bytes', async () => {
    const h = setup()
    const track = song('a')
    const bytes = h.serve(track, 5000)
    h.server.rule(mediaUrl(track, 1), { capAt: 3000 })
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect((await h.record(track))?.status).toBe('completed')
    expect(h.storage.bytes('file-1')).toEqual(bytes)
    expect(h.resolver.reasonsFor(track)).toEqual(['start', 'refresh'])
    expect([...(h.resolver.calls[1]?.request.exclude ?? [])]).toEqual([mediaUrl(track, 1)])
    expect(h.server.rangesFor(mediaUrl(track, 2))).toEqual(ranges(2048, 5000))
  })

  it('resolves afresh when a signed URL gets no answer: on the web, a redirect', async () => {
    const h = setup()
    const track = song('a')
    h.serve(track, 3000)
    h.server.rule(mediaUrl(track, 1), { dropRequests: 1 })
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect((await h.record(track))?.status).toBe('completed')
    expect(h.resolver.reasonsFor(track)).toEqual(['start', 'refresh'])
  })

  it("fails at once when the browser won't let the page read a signed URL", async () => {
    // googlevideo redirected the transfer to another host, and an FXM Connect older than 0.2.1
    // leaves the answer unreadable; or FXM Connect's rules don't apply at all. Resolving afresh
    // can't help: the download fails with the reason, without a second resolution.
    for (const [unreadable, code] of [
      ['redirected', 'redirected'],
      ['refused', 'unreadable'],
    ] as const) {
      const h = setup({ retryDelaysMs: [1] })
      const track = song('a')
      h.serve(track, 3000)
      h.server.rule(mediaUrl(track, 1), { unreadable })
      await h.manager.start()
      await h.manager.enqueue(track)
      await h.manager.idle()
      expect(await h.record(track)).toMatchObject({ status: 'failed', error: { code } })
      expect(h.resolver.reasonsFor(track)).toEqual(['start'])
    }
  })

  it('retries a stable URL after a passing failure, without resolving again', async () => {
    const h = setup({ retryDelaysMs: [5] })
    const track = song('a')
    const url = 'https://archive.test/a.flac'
    h.server.add(url, testBytes(3000))
    h.server.rule(url, { dropRequests: 1 })
    h.resolver.handler = () => ({
      candidate: downloadCandidate(track),
      stream: downloadStream(url, { ipBound: false }),
    })
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'completed', attempts: 0 })
    expect(h.resolver.calls).toHaveLength(1)
    expect(h.server.rangesFor(url)).toEqual(['bytes=0-1023', ...ranges(0, 3000)])
  })

  it('waits as long as the server asks, and counts the attempts', async () => {
    vi.useFakeTimers()
    const h = setup()
    const track = song('a')
    const url = 'https://archive.test/a.flac'
    h.server.add(url, testBytes(2000))
    h.server.rule(url, { status: 503, statusTimes: 1, retryAfterSeconds: 30 })
    h.resolver.handler = () => ({
      candidate: downloadCandidate(track),
      stream: downloadStream(url, { ipBound: false }),
    })
    await h.manager.start()
    await h.manager.enqueue(track)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(await h.record(track)).toMatchObject({ status: 'downloading', attempts: 1 })
    await vi.advanceTimersByTimeAsync(1_000)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'completed', attempts: 0 })
  })

  it('fails once passing failures run out', async () => {
    const h = setup({ maxAttempts: 3, retryDelaysMs: [1] })
    const track = song('a')
    const url = 'https://archive.test/a.flac'
    h.server.add(url, testBytes(2000))
    h.server.rule(url, { status: 500 })
    h.resolver.handler = () => ({
      candidate: downloadCandidate(track),
      stream: downloadStream(url, { ipBound: false }),
    })
    const failed = vi.fn()
    h.manager.on('failed', failed)
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({
      status: 'failed',
      attempts: 3,
      error: { code: 'server' },
    })
    expect(h.server.requests).toHaveLength(3)
    expect(failed).toHaveBeenCalledTimes(1)
    // A retry starts the count over.
    h.server.clearRules(url)
    expect((await h.manager.retry(downloadId(track)))?.attempts).toBe(0)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'completed' })
    expect(await h.record(track)).not.toHaveProperty('error')
  })

  it('fails when no stream passes the end-of-file probe, after fresh resolutions', async () => {
    const h = setup()
    const track = song('a')
    h.resolver.handler = () => {
      throw new NoDownloadableStreamError('unverified', 'capped everywhere')
    }
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'failed', error: { code: 'unverified' } })
    expect(h.resolver.reasonsFor(track)).toEqual(['start', 'refresh', 'refresh', 'refresh'])
  })

  it('refuses an unverified YouTube stream from any resolver', async () => {
    const h = setup({ maxRefreshes: 0 })
    const track = song('a')
    h.serve(track, 1000)
    h.resolver.handler = (_track, _request, call) => ({
      candidate: downloadCandidate(track),
      stream: downloadStream(mediaUrl(track, call), { fullLength: 'unverified' }),
    })
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'failed', error: { code: 'unverified' } })
    expect(h.server.requests).toHaveLength(0)
  })

  it.each([
    ['unsupported', new FxmError('Unsupported', 'no FXM Connect')],
    ['bot-check', new FxmError('BotCheck', 'prove it')],
    [
      'needs-review',
      playbackProblemError({
        type: 'needs-review',
        trackId: formatId('ytm', 'track', 'a'),
        guess: testCandidate('m'),
        alternatives: [],
      }),
    ],
    [
      'unavailable',
      playbackProblemError({
        type: 'unavailable',
        trackId: formatId('ytm', 'track', 'a'),
        reason: 'unplayable',
        alternatives: [],
      }),
    ],
  ])('fails at once with %s', async (code, error) => {
    const h = setup()
    const track = song('a')
    h.resolver.handler = () => {
      throw error
    }
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'failed', error: { code } })
    expect(h.resolver.calls).toHaveLength(1)
  })

  it('starts the file over when a resume gets another format', async () => {
    const h = setup()
    const track = song('a')
    const bytes = h.serve(track, 5000)
    h.server.rule(mediaUrl(track, 1), { holdAt: 2600 })
    await h.manager.start()
    await h.manager.enqueue(track)
    await vi.waitFor(() =>
      expect(h.server.rangesFor(mediaUrl(track, 1))).toContain('bytes=2048-3071'),
    )
    await h.manager.pause(downloadId(track))
    await h.manager.idle()
    const aac = testBytes(3000, 9)
    h.resolver.handler = (_track, _request, call) => {
      h.server.add(mediaUrl(track, call), aac)
      return {
        candidate: downloadCandidate(track),
        stream: downloadStream(mediaUrl(track, call), {
          codec: 'aac',
          container: 'm4a',
          bitrateKbps: 130,
        }),
      }
    }
    await h.manager.resume(downloadId(track))
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({
      status: 'completed',
      bytesTotal: 3000,
      format: { codec: 'aac', container: 'm4a' },
    })
    expect(h.storage.bytes('file-1')).toEqual(aac)
    expect(h.storage.bytes('file-1')).not.toEqual(bytes.slice(0, 3000))
    expect(h.server.rangesFor(mediaUrl(track, 2))).toEqual(ranges(0, 3000))
  })

  it('starts the file over when it changed on the server', async () => {
    const h = setup()
    const track = song('a')
    const fresh = testBytes(4000, 3)
    h.resolver.handler = (_track, _request, call) => {
      const url = mediaUrl(track, call)
      h.server.add(url, {
        bytes: call === 1 ? testBytes(4000) : fresh,
        lastModified:
          call === 1 ? 'Sat, 24 Oct 2026 10:00:00 GMT' : 'Sun, 25 Oct 2026 10:00:00 GMT',
      })
      if (call === 1) h.server.rule(url, { holdAt: 1500 })
      return { candidate: downloadCandidate(track), stream: downloadStream(url) }
    }
    await h.manager.start()
    await h.manager.enqueue(track)
    await vi.waitFor(() => expect(h.server.requests).toHaveLength(2))
    await h.manager.pause(downloadId(track))
    await h.manager.idle()
    await h.manager.resume(downloadId(track))
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({
      status: 'completed',
      validator: 'last-modified:Sun, 25 Oct 2026 10:00:00 GMT',
    })
    expect(h.storage.bytes('file-1')).toEqual(fresh)
    expect(h.resolver.reasonsFor(track)).toEqual(['start', 'resume', 'start'])
  })

  it('pauses the queue when the storage is full', async () => {
    const storage = createMemoryDownloadStorage({ quotaBytes: 3000 })
    const h = setup({ storage, concurrency: 1 })
    const [a, b] = [song('a'), song('b')]
    h.serve(a, 5000)
    h.serve(b, 1000)
    await h.manager.start()
    await h.manager.enqueueAll([a, b])
    await h.manager.idle()
    expect(await h.record(a)).toMatchObject({ status: 'failed', error: { code: 'storage-full' } })
    // b would fail the same way, after a resolution: it waits, paused, saying why.
    expect(await h.record(b)).toMatchObject({ status: 'paused', error: { code: 'storage-full' } })
    expect(h.resolver.calls).toHaveLength(1)
    // Resuming forgets the reason.
    expect(await h.manager.resume(downloadId(b))).not.toHaveProperty('error')
  })

  it('waits for the network, then resolves afresh', async () => {
    const h = setup()
    const track = song('a')
    const bytes = h.serve(track, 5000)
    h.server.rule(mediaUrl(track, 1), { holdAt: 1500 })
    await h.manager.start()
    await h.manager.enqueue(track)
    await vi.waitFor(() => expect(h.server.requests).toHaveLength(2))
    h.network.set(false)
    h.server.release(mediaUrl(track, 1))
    await vi.waitFor(() => expect(h.server.requests).toHaveLength(2))
    // Offline, it waits without counting an attempt.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await h.record(track)).toMatchObject({ status: 'downloading', attempts: 0 })
    h.network.set(true)
    await h.manager.idle()
    expect((await h.record(track))?.status).toBe('completed')
    expect(h.storage.bytes('file-1')).toEqual(bytes)
    expect(h.resolver.reasonsFor(track)).toEqual(['start', 'refresh'])
    expect(h.server.rangesFor(mediaUrl(track, 2))).toEqual(ranges(2048, 5000))
  })

  it('starts nothing while offline', async () => {
    const h = setup()
    const track = song('a')
    h.serve(track, 1000)
    h.network.set(false)
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect((await h.record(track))?.status).toBe('queued')
    h.network.set(true)
    await vi.waitFor(async () => expect((await h.record(track))?.status).toBe('completed'))
  })

  it('never downloads YouTube audio without readable bytes', async () => {
    const h = setup({ tier: 'lite' })
    const track = song('a')
    await expect(h.manager.enqueue(track)).rejects.toMatchObject({ code: 'Unsupported' })
    expect(h.manager.availability(track)).toEqual({
      available: false,
      reason: 'needs-full-access',
    })
    expect(await h.manager.enqueueAll([track])).toEqual({ queued: 0, present: 0, skipped: 1 })
  })

  it('fails a queued download when the bytes become unreadable', async () => {
    const h = setup()
    const track = song('a')
    await h.manager.enqueue(track)
    h.setTier('lite')
    await h.manager.start()
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({
      status: 'failed',
      error: { code: 'unsupported' },
    })
    expect(h.resolver.calls).toHaveLength(0)
  })

  it('fails as unknown what keeps breaking for no known reason', async () => {
    const h = setup({ maxAttempts: 2, retryDelaysMs: [1] })
    const track = song('a')
    h.serve(track, 1000)
    h.storage.failNext('open', new Error('odd'))
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect((await h.record(track))?.status).toBe('completed')
    h.storage.failNext('open', new Error('odd'))
    const again = song('b')
    h.serve(again, 1000)
    h.resolver.handler = () => {
      throw new Error('broken')
    }
    await h.manager.enqueue(again)
    await h.manager.idle()
    expect(await h.record(again)).toMatchObject({ status: 'failed', error: { code: 'unknown' } })
  })
})

describe('starting and stopping', () => {
  it('tidies up after a manager that stopped without warning', async () => {
    const a = song('a')
    const b = song('b')
    const bytes = testBytes(4000, 1)
    const running: DownloadRecord = {
      ...newDownloadRecord(a, 1),
      status: 'downloading',
      file: 'file-a',
      bytesDone: 1000,
      candidate: downloadCandidate(a),
      format: fileFormatOf(downloadStream('x')),
    }
    const gone: DownloadRecord = {
      ...newDownloadRecord(b, 2),
      status: 'completed',
      file: 'file-b',
      bytesDone: 10,
      bytesTotal: 10,
    }
    const h = setup({ records: [running, gone] })
    h.serve(a, bytes)
    h.storage.put('file-a', bytes.slice(0, 1000))
    h.storage.put('orphan', testBytes(5))
    await h.manager.start()
    await h.manager.idle()
    expect(await h.record(a)).toMatchObject({ status: 'completed', bytesTotal: 4000 })
    expect(h.storage.bytes('file-a')).toEqual(bytes)
    expect(h.server.rangesFor(mediaUrl(a, 1))).toEqual(ranges(1000, 4000))
    expect(h.resolver.reasonsFor(a)).toEqual(['resume'])
    expect(await h.record(b)).toMatchObject({
      status: 'failed',
      bytesDone: 0,
      error: { code: 'file-missing' },
    })
    expect(await h.storage.list()).toEqual(['file-a'])
  })

  it('starts a file over that holds more than the whole file', async () => {
    const a = song('a')
    const bytes = testBytes(3000)
    const stale: DownloadRecord = {
      ...newDownloadRecord(a, 1),
      status: 'queued',
      file: 'file-a',
      bytesDone: 4000,
      bytesTotal: 3000,
      candidate: downloadCandidate(a),
      format: fileFormatOf(downloadStream('x')),
    }
    const h = setup({ records: [stale] })
    h.serve(a, bytes)
    h.storage.put('file-a', testBytes(4000, 5))
    await h.manager.start()
    await h.manager.idle()
    expect(h.storage.bytes('file-a')).toEqual(bytes)
  })

  it('stops running downloads where they are, for the next manager to continue', async () => {
    const h = setup()
    const track = song('a')
    const bytes = h.serve(track, 5000)
    h.server.rule(mediaUrl(track, 1), { holdAt: 2100 })
    await h.manager.start()
    await h.manager.enqueue(track)
    await vi.waitFor(() => expect(h.server.requests).toHaveLength(3))
    await h.manager.stop()
    await h.manager.stop()
    expect(h.manager.running).toBe(false)
    expect(await h.record(track)).toMatchObject({ status: 'downloading', bytesDone: 2100 })
    const next = setup({ store: h.store, storage: h.storage })
    next.serve(track, bytes)
    await next.manager.start()
    await next.manager.start()
    await next.manager.idle()
    expect((await next.record(track))?.status).toBe('completed')
    expect(h.storage.bytes('file-1')).toEqual(bytes)
    await next.manager.destroy()
  })

  it('still runs the queue when tidying up fails', async () => {
    const h = setup()
    const track = song('a')
    h.serve(track, 1000)
    h.storage.failNext('list', new Error('no directory'))
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect((await h.record(track))?.status).toBe('completed')
  })
})

describe('commands on many downloads', () => {
  it('queues a list in order, once each, and skips what this platform cannot download', async () => {
    const h = setup()
    const local = song('mine')
    const tracks = [
      song('a'),
      song('b'),
      song('a'),
      { ...local, id: formatId('local', 'track', 'x'), source: 'local' as const },
    ]
    expect(await h.manager.enqueueAll(tracks)).toEqual({ queued: 2, present: 0, skipped: 1 })
    expect(await h.manager.enqueueAll(tracks)).toEqual({ queued: 0, present: 2, skipped: 1 })
    expect((await h.manager.list()).map((record) => record.track.title)).toEqual(['a', 'b'])
  })

  it('pauses, resumes and removes every download', async () => {
    const h = setup()
    const tracks = [song('a'), song('b')]
    for (const track of tracks) h.serve(track, 1000)
    await h.manager.enqueueAll(tracks)
    await h.manager.pauseAll()
    expect((await h.manager.list()).map((record) => record.status)).toEqual(['paused', 'paused'])
    await h.manager.start()
    await h.manager.idle()
    expect(h.resolver.calls).toHaveLength(0)
    await h.manager.resumeAll()
    await h.manager.idle()
    expect((await h.manager.list()).map((record) => record.status)).toEqual([
      'completed',
      'completed',
    ])
    const removed = await h.manager.removeAll()
    expect(removed.map((record) => record.track.title)).toEqual(['a', 'b'])
    await h.manager.idle()
    expect(await h.store.list()).toEqual([])
    expect(await h.storage.list()).toEqual([])
  })
})

/** Twenty YouTube Music songs, served. */
function twentySongs(h: ReturnType<typeof setup>): Track[] {
  const songs = Array.from({ length: 20 }, (_, index) => song(`s${index}`))
  for (const track of songs) h.serve(track, 1000)
  return songs
}

describe('when YouTube or the request budget says stop', () => {
  it('holds every YouTube download while the budget refuses, and fails none', async () => {
    vi.useFakeTimers()
    const h = setup()
    const songs = twentySongs(h)
    const free = archiveFile('free')
    h.serve(free, 1000)
    const working = h.resolver.handler
    let refuse = true
    h.resolver.handler = (track, request, call) => {
      if (refuse && downloadLane(track) === 'youtube') {
        throw new FxmError('RateLimited', 'The request budget refused', { retryAfterMs: 120_000 })
      }
      return working(track, request, call)
    }
    await h.manager.start()
    await h.manager.enqueueAll([...songs, free])
    await h.manager.idle()
    const asked = () => h.resolver.calls.filter((call) => downloadLane(call.track) === 'youtube')
    // One resolution per slot, then the lane waits; Internet Archive goes on meanwhile.
    expect(asked()).toHaveLength(2)
    expect((await h.record(free))?.status).toBe('completed')
    for (const track of songs) {
      expect(await h.record(track)).toMatchObject({ status: 'queued', attempts: 0 })
    }
    await vi.advanceTimersByTimeAsync(119_000)
    expect(asked()).toHaveLength(2)
    refuse = false
    await vi.advanceTimersByTimeAsync(1_000)
    await h.manager.idle()
    for (const track of songs) expect((await h.record(track))?.status).toBe('completed')
    expect(asked()).toHaveLength(22)
  })

  it('asks again after the longest wait when the budget names none', async () => {
    vi.useFakeTimers()
    const h = setup({ concurrency: 1 })
    const track = song('a')
    h.serve(track, 1000)
    const working = h.resolver.handler
    let refusals = 2
    h.resolver.handler = (target, request, call) => {
      if (refusals > 0) {
        refusals -= 1
        throw new FxmError('RateLimited', 'Slow down')
      }
      return working(target, request, call)
    }
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(h.resolver.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await h.manager.idle()
    expect(h.resolver.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'completed', attempts: 0 })
  })

  it('pauses the other YouTube downloads after a bot check, saying why', async () => {
    const h = setup()
    const songs = twentySongs(h)
    const free = archiveFile('free')
    h.serve(free, 1000)
    const working = h.resolver.handler
    h.resolver.handler = (track, request, call) => {
      if (downloadLane(track) === 'youtube') throw new FxmError('BotCheck', 'Prove it')
      return working(track, request, call)
    }
    await h.manager.start()
    await h.manager.enqueueAll([...songs, free])
    await h.manager.idle()
    // The two that were running fail; the other eighteen never ask YouTube.
    expect(h.resolver.calls.filter((call) => downloadLane(call.track) === 'youtube')).toHaveLength(
      2,
    )
    const records = await Promise.all(songs.map((track) => h.record(track)))
    const failed = records.filter((record) => record?.status === 'failed')
    const paused = records.filter((record) => record?.status === 'paused')
    expect(failed).toHaveLength(2)
    expect(paused).toHaveLength(18)
    for (const record of [...failed, ...paused]) {
      expect(record?.error?.code).toBe('bot-check')
    }
    expect((await h.record(free))?.status).toBe('completed')
  })

  it('gives the slot back while a server asks to wait, and comes back after it', async () => {
    vi.useFakeTimers()
    const h = setup({ concurrency: 1 })
    const [a, b] = [song('a'), song('b')]
    h.serve(b, 1000)
    const url = 'https://archive.test/a.flac'
    h.server.add(url, testBytes(2000))
    h.server.rule(url, { status: 503, statusTimes: 1, retryAfterSeconds: 120 })
    const working = h.resolver.handler
    h.resolver.handler = (track, request, call) =>
      track === a
        ? { candidate: downloadCandidate(a), stream: downloadStream(url, { ipBound: false }) }
        : working(track, request, call)
    await h.manager.start()
    await h.manager.enqueueAll([a, b])
    await h.manager.idle()
    expect(await h.record(a)).toMatchObject({ status: 'queued', attempts: 1 })
    expect((await h.record(b))?.status).toBe('completed')
    await vi.advanceTimersByTimeAsync(120_000)
    await h.manager.idle()
    expect(await h.record(a)).toMatchObject({ status: 'completed', attempts: 0 })
  })

  it('fails a download whose server asks to wait too long', async () => {
    const h = setup()
    const track = song('a')
    const url = 'https://archive.test/a.flac'
    h.server.add(url, testBytes(2000))
    h.server.rule(url, { status: 429, retryAfterSeconds: 3_600 })
    h.resolver.handler = () => ({
      candidate: downloadCandidate(track),
      stream: downloadStream(url, { ipBound: false }),
    })
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'failed', error: { code: 'server' } })
    expect(h.server.requests).toHaveLength(1)
  })
})

describe('progress and limits', () => {
  it('retries a signed URL whose answer broke off, without resolving again', async () => {
    const h = setup({ retryDelaysMs: [1] })
    const track = song('a')
    const bytes = h.serve(track, 5000)
    h.server.rule(mediaUrl(track, 1), { breakAt: 1500 })
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect((await h.record(track))?.status).toBe('completed')
    expect(h.storage.bytes('file-1')).toEqual(bytes)
    expect(h.resolver.reasonsFor(track)).toEqual(['start'])
  })

  it('keeps going while every attempt stores more of the file', async () => {
    const h = setup({ maxAttempts: 3, retryDelaysMs: [1] })
    const track = song('a')
    const url = 'https://archive.test/a.flac'
    const bytes = testBytes(8000)
    h.server.add(url, bytes)
    // A flaky connection: every answer breaks off after 512 bytes.
    h.server.rule(url, { breakEvery: 512 })
    h.resolver.handler = () => ({
      candidate: downloadCandidate(track),
      stream: downloadStream(url, { ipBound: false }),
    })
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'completed', attempts: 0 })
    expect(h.storage.bytes('file-1')).toEqual(bytes)
    // Failures that store nothing still count.
    h.server.rule(url, { breakEvery: 0 })
    const again = song('b')
    h.resolver.handler = () => ({
      candidate: downloadCandidate(again),
      stream: downloadStream(url, { ipBound: false }),
    })
    await h.manager.enqueue(again)
    await h.manager.idle()
    expect(await h.record(again)).toMatchObject({
      status: 'failed',
      attempts: 3,
      error: { code: 'network' },
    })
  })

  it('never completes an empty file', async () => {
    const h = setup({ maxRefreshes: 1 })
    const track = song('a')
    h.serve(track, new Uint8Array(0))
    const completed = vi.fn()
    h.manager.on('completed', completed)
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'failed', error: { code: 'server' } })
    expect(completed).not.toHaveBeenCalled()
    expect(h.resolver.reasonsFor(track)).toEqual(['start', 'refresh'])
  })

  it('keeps nothing of a file far larger than the song can be', async () => {
    const h = setup()
    const track: Track = { ...song('a'), durationMs: 1_000 }
    h.serve(track, 5000)
    // The server says the file has 10 GiB.
    h.server.rule(mediaUrl(track, 1), { claimSize: 10 * 1024 ** 3 })
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({
      status: 'failed',
      bytesDone: 0,
      error: { code: 'too-large' },
    })
    expect(h.storage.bytes('file-1')).toHaveLength(0)
    expect(h.server.requests).toHaveLength(1)
  })

  it('never lets a file name that could be a path reach the storage', async () => {
    const h = setup({ createFileName: () => '../../escape' })
    const track = song('a')
    h.serve(track, 1000)
    await h.manager.start()
    await h.manager.enqueue(track)
    await h.manager.idle()
    expect(await h.record(track)).toMatchObject({ status: 'failed', error: { code: 'unknown' } })
    expect(await h.storage.list()).toEqual([])
    expect(h.server.requests).toHaveLength(0)
  })
})

describe('housekeeping', () => {
  it('keeps the files of rows it cannot read, and "remove all" removes those rows', async () => {
    const a = song('a')
    // A row a newer FXM wrote, with a status this version doesn't know.
    const newer = {
      ...newDownloadRecord(a, 1),
      status: 'converting',
      file: 'file-newer',
    } as unknown as DownloadRecord
    const h = setup({ records: [newer] })
    h.storage.put('file-newer', testBytes(10))
    h.storage.put('orphan', testBytes(5))
    await h.manager.start()
    await h.manager.idle()
    expect(await h.storage.list()).toEqual(['file-newer'])
    expect(await h.manager.removeAll()).toEqual([])
    await h.manager.idle()
    expect(await h.store.rows()).toEqual([])
    // Nothing names its file any more: the next start deletes it.
    await h.manager.stop()
    await h.manager.start()
    await h.manager.idle()
    expect(await h.storage.list()).toEqual([])
  })

  it('changes the store once for a command on many downloads', async () => {
    const h = setup()
    const tracks = [song('a'), song('b'), song('c')]
    const updateMany = vi.spyOn(h.store, 'updateMany')
    const update = vi.spyOn(h.store, 'update')
    expect(await h.manager.enqueueAll(tracks)).toEqual({ queued: 3, present: 0, skipped: 0 })
    expect((await h.manager.list()).map((record) => record.track.title)).toEqual(['a', 'b', 'c'])
    await h.manager.pauseAll()
    await h.manager.resumeAll()
    expect(await h.manager.removeMany(tracks.map(downloadId))).toHaveLength(3)
    expect(updateMany).toHaveBeenCalledTimes(4)
    expect(update).not.toHaveBeenCalled()
  })
})

describe('a storage that hangs', () => {
  it('frees the slot of a download paused while its file never opens', async () => {
    const memory = createMemoryDownloadStorage()
    let hang = true
    const storage: DownloadStorage = {
      ...memory,
      open: (file) => (hang ? new Promise(() => {}) : memory.open(file)),
    }
    const h = setup({ storage, concurrency: 1 })
    const [a, b] = [song('a'), song('b')]
    h.serve(a, 1000)
    const bytes = h.serve(b, 1000)
    await h.manager.start()
    await h.manager.enqueueAll([a, b])
    await vi.waitFor(() => expect(h.resolver.calls).toHaveLength(1))
    hang = false
    await h.manager.pause(downloadId(a))
    await h.manager.idle()
    expect((await h.record(a))?.status).toBe('paused')
    expect((await h.record(b))?.status).toBe('completed')
    expect(memory.bytes('file-2')).toEqual(bytes)
  })

  it('goes on when the storage never deletes a file', async () => {
    vi.useFakeTimers()
    const memory = createMemoryDownloadStorage()
    let hang = false
    const storage: DownloadStorage = {
      ...memory,
      remove: (file) => (hang ? new Promise(() => {}) : memory.remove(file)),
    }
    const h = setup({ storage })
    const [a, b] = [song('a'), song('b')]
    h.serve(a, 1000)
    h.serve(b, 1000)
    await h.manager.start()
    await h.manager.enqueue(a)
    await h.manager.idle()
    hang = true
    const removed = vi.fn()
    h.manager.on('removed', removed)
    await h.manager.remove(downloadId(a))
    await h.manager.enqueue(b)
    await vi.advanceTimersByTimeAsync(30_000)
    await h.manager.idle()
    expect(removed).toHaveBeenCalledTimes(1)
    expect(await h.record(a)).toBeUndefined()
    expect((await h.record(b))?.status).toBe('completed')
  })
})

describe('stopping', () => {
  it('starts nothing once stopped, also a download a pass was starting just then', async () => {
    const inner = createMemoryDownloadStore()
    let open: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    let blocked = false
    // A store that is slow to save the start of a download: stop() comes meanwhile.
    const store: DownloadStore = {
      ...inner,
      async update(id, change) {
        const current = await inner.get(id)
        if (current?.status === 'queued' && change(current)?.status === 'downloading') {
          blocked = true
          await gate
        }
        return inner.update(id, change)
      },
    }
    const h = setup({ store })
    const track = song('a')
    h.serve(track, 3000)
    await h.manager.start()
    await h.manager.enqueue(track)
    await vi.waitFor(() => expect(blocked).toBe(true))
    const stopped = h.manager.stop()
    // A second stop waits for the same thing.
    const again = h.manager.stop()
    open?.()
    await Promise.all([stopped, again])
    expect(h.manager.running).toBe(false)
    expect(h.server.requests).toHaveLength(0)
    expect((await h.record(track))?.status).toBe('queued')
  })
})
