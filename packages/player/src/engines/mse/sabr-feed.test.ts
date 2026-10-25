import {
  FormatInitializationMetadata,
  MediaHeader,
  NextRequestPolicy,
  UMPPartId,
  VideoPlaybackAbrRequest,
} from 'googlevideo/protos'
import { CompositeBuffer, UmpWriter } from 'googlevideo/ump'
import { concatenateChunks } from 'googlevideo/utils'
import { describe, expect, it } from 'vitest'
import { startSabrFeed } from './sabr-feed'
import { SESSION, sabrStream } from './testing'

const AUDIO_ID = {
  itag: SESSION.audio.itag,
  lastModified: SESSION.audio.lastModified,
  xtags: '',
}

/** The answer once everything was sent: only a request policy, no media. */
function umpDone(): Uint8Array {
  const buffer = new CompositeBuffer()
  new UmpWriter(buffer).write(UMPPartId.NEXT_REQUEST_POLICY, NextRequestPolicy.encode({}).finish())
  return concatenateChunks(buffer.chunks)
}

/** One UMP answer: the audio format's metadata, its initialization segment and one media segment. */
function umpAnswer(init: Uint8Array, media: Uint8Array): Uint8Array {
  const buffer = new CompositeBuffer()
  const writer = new UmpWriter(buffer)
  writer.write(
    UMPPartId.FORMAT_INITIALIZATION_METADATA,
    FormatInitializationMetadata.encode({
      videoId: SESSION.videoId,
      formatId: AUDIO_ID,
      endTimeMs: '2000',
      endSegmentNumber: '1',
      mimeType: SESSION.audio.mimeType,
      durationUnits: '2000',
      durationTimescale: '1000',
    }).finish(),
  )
  const segment = (headerId: number, data: Uint8Array, header: Partial<MediaHeader>) => {
    writer.write(
      UMPPartId.MEDIA_HEADER,
      MediaHeader.encode({
        headerId,
        videoId: SESSION.videoId,
        itag: AUDIO_ID.itag,
        lmt: AUDIO_ID.lastModified,
        xtags: '',
        formatId: AUDIO_ID,
        contentLength: String(data.byteLength),
        ...header,
      }).finish(),
    )
    writer.write(UMPPartId.MEDIA, new Uint8Array([headerId, ...data]))
    writer.write(UMPPartId.MEDIA_END, new Uint8Array([headerId]))
  }
  segment(0, init, { isInitSeg: true, durationMs: '0', startMs: '0' })
  segment(1, media, { sequenceNumber: 1, startMs: '0', durationMs: '2000' })
  return concatenateChunks(buffer.chunks)
}

describe('the SABR feed', () => {
  it("posts the session's request and hands out the audio segments in order", async () => {
    const requests: Array<{ url: URL; headers: Headers; body: Uint8Array }> = []
    const init = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])
    const media = new Uint8Array([1, 2, 3, 4, 5, 6])
    const fetch = (async (input: RequestInfo | URL, init_?: RequestInit) => {
      const body = init_?.body as Uint8Array
      requests.push({ url: new URL(String(input)), headers: new Headers(init_?.headers), body })
      // googlevideo's SabrStream asks once more after the last segment.
      const answer = requests.length === 1 ? umpAnswer(init, media) : umpDone()
      return new Response(answer as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { 'content-type': 'application/vnd.yt-ump' },
      })
    }) as typeof globalThis.fetch
    const stream = sabrStream()
    const feed = await startSabrFeed(SESSION, stream.url, fetch)
    const reader = feed.audio.getReader()
    const received: number[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received.push(...value)
    }
    expect(received).toEqual([...init, ...media])
    expect(requests).toHaveLength(2)
    const [request] = requests
    expect(request?.url.searchParams.get('rn')).toBe('0')
    expect(request?.url.searchParams.get('sabr')).toBe('1')
    expect(request?.headers.get('content-type')).toBe('application/x-protobuf')
    const decoded = VideoPlaybackAbrRequest.decode(request?.body ?? new Uint8Array())
    expect(decoded.streamerContext?.clientInfo).toMatchObject({
      clientName: SESSION.client.nameId,
      clientVersion: SESSION.client.version,
    })
    expect(decoded.streamerContext?.poToken?.byteLength).toBeGreaterThan(0)
    expect(decoded.videoPlaybackUstreamerConfig?.byteLength).toBeGreaterThan(0)
    expect(decoded.preferredAudioFormatIds?.[0]).toMatchObject({ itag: SESSION.audio.itag })
    // Audio only: the video format is reported as fully buffered, so none is sent.
    expect(
      decoded.bufferedRanges?.some((range) => range.formatId?.itag === SESSION.video.itag),
    ).toBe(true)
  })

  it('ends the audio with an error when the server refuses the session', async () => {
    const fetch = (async () => new Response('', { status: 403 })) as typeof globalThis.fetch
    const feed = await startSabrFeed(SESSION, sabrStream().url, fetch)
    const reader = feed.audio.getReader()
    const failure = await reader.read().then(
      () => undefined,
      (error: unknown) => error,
    )
    feed.abort()
    expect(String(failure)).toMatch(/403/u)
  }, 60_000)
})
