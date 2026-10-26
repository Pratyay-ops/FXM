import { describe, expect, it } from 'vitest'
import { exportAudio, inputExtension } from './exporter'
import { demuxMp4Audio } from './mp4/demux'
import {
  FAKE_WEBM_MAGIC,
  FakeFfmpegCore,
  flacFile,
  fragmentedM4aFile,
  id3Summary,
  itag18File,
  mp3File,
  oggOpusFile,
  oggVorbisFile,
  readFlacBlocks,
  readMp4Tags,
  readOggPackets,
  readOggPages,
  readRiffChunks,
  readVorbisComments,
  sineWav,
  topLevelBoxes,
} from './testing'
import { ConvertError, type ExportTags, type SourceAudio } from './types'

const TAGS: ExportTags = {
  title: 'Song',
  artists: ['Artist'],
  album: 'Album',
  lyrics: 'Line one',
  cover: { mimeType: 'image/jpeg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 1]) },
}

const OPUS_WEBM: SourceAudio = { codec: 'opus', container: 'webm', media: 'audio' }
const AAC: SourceAudio = { codec: 'aac', container: 'm4a', media: 'audio' }
const ITAG_18: SourceAudio = { codec: 'aac', container: 'mp4', media: 'muxed-video' }

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

function setup() {
  const core = new FakeFfmpegCore()
  let loads = 0
  return {
    core,
    loads: () => loads,
    deps: {
      loadCore: async () => {
        loads += 1
        return core
      },
    },
  }
}

describe('exportAudio', () => {
  it('saves an itag 18 video’s AAC as a tagged M4A, without the core', async () => {
    const { deps, loads } = setup()
    const result = await exportAudio(
      {
        input: new Blob([itag18File() as BlobPart]),
        source: ITAG_18,
        format: 'original',
        tags: TAGS,
      },
      deps,
    )
    const file = await bytes(result.blob)
    expect(result).toMatchObject({ tagged: true, plan: { extractAudio: true } })
    expect(result.blob.type).toBe('audio/mp4')
    expect(topLevelBoxes(file)).toEqual(['ftyp', 'moov', 'mdat'])
    expect(readMp4Tags(file)['©nam']).toBe('Song')
    // Audio only: one track, and no video sample entry anywhere.
    expect(new TextDecoder('latin1').decode(file)).not.toContain('avc1')
    expect(loads()).toBe(0)
  })

  it('extracts an itag 18 video’s AAC before converting it', async () => {
    const { deps, core } = setup()
    const result = await exportAudio(
      { input: itag18File(), source: ITAG_18, format: 'mp3', tags: TAGS },
      deps,
    )
    const call = core.calls[0]
    expect(call?.inputExtension).toBe('m4a')
    expect(call?.job).toEqual({ format: 'mp3', codec: 'libmp3lame', bitRate: 320_000 })
    // The core got the AAC alone, as an M4A file.
    expect(demuxMp4Audio(call?.input ?? new Uint8Array()).type).toBe('mp4a')
    expect(id3Summary(await bytes(result.blob))).toMatchObject({ TIT2: 'Song', USLT: 'Line one' })
  })

  it('rewrites YouTube’s fragmented M4A as a plain tagged one for Original', async () => {
    const { deps } = setup()
    const result = await exportAudio(
      { input: fragmentedM4aFile(), source: AAC, format: 'original', tags: TAGS },
      deps,
    )
    const file = await bytes(result.blob)
    expect(topLevelBoxes(file)).toEqual(['ftyp', 'moov', 'mdat'])
    expect(readMp4Tags(file)).toMatchObject({ '©ART': 'Artist', covr: 'type 13, 6 bytes' })
  })

  it('remuxes an original WebM through the core with its tags', async () => {
    const { deps, core } = setup()
    const result = await exportAudio(
      { input: new Uint8Array([1, 2, 3]), source: OPUS_WEBM, format: 'original', tags: TAGS },
      deps,
    )
    expect(core.calls[0]?.job).toEqual({
      format: 'webm',
      codec: 'copy',
      metadata: { title: 'Song', artist: 'Artist', album: 'Album', lyrics: 'Line one' },
    })
    expect(core.calls[0]?.inputExtension).toBe('webm')
    expect((await bytes(result.blob)).subarray(0, 4)).toEqual(FAKE_WEBM_MAGIC)
    expect(result.blob.type).toBe('audio/webm')
  })

  it('converts to each format and tags the result with the format’s writer', async () => {
    const { deps } = setup()
    const flac = await exportAudio(
      { input: new Uint8Array(4), source: OPUS_WEBM, format: 'flac', tags: TAGS },
      deps,
    )
    const flacBytes = await bytes(flac.blob)
    const comments = readVorbisComments(
      readFlacBlocks(flacBytes).blocks[1]?.body ?? new Uint8Array(),
    )
    expect(comments.fields).toContainEqual(['TITLE', 'Song'])

    const opus = await exportAudio(
      { input: new Uint8Array(4), source: AAC, format: 'opus', tags: TAGS },
      deps,
    )
    const packets = readOggPackets(readOggPages(await bytes(opus.blob)))
    expect(readVorbisComments((packets[1] ?? new Uint8Array()).subarray(8)).fields).toContainEqual([
      'ALBUM',
      'Album',
    ])

    const wav = await exportAudio(
      { input: new Uint8Array(4), source: OPUS_WEBM, format: 'wav', tags: TAGS },
      deps,
    )
    expect(readRiffChunks(await bytes(wav.blob)).map((chunk) => chunk.id)).toEqual([
      'fmt ',
      'data',
      'LIST',
      'id3 ',
    ])

    const alac = await exportAudio(
      { input: new Uint8Array(4), source: OPUS_WEBM, format: 'alac', tags: TAGS },
      deps,
    )
    const alacBytes = await bytes(alac.blob)
    expect(readMp4Tags(alacBytes)['©alb']).toBe('Album')
    // The core's edit list (priming) survives the rewrite.
    expect(demuxMp4Audio(alacBytes).mediaTime).toBe(1024)
  })

  it('tags free sources’ originals without the core', async () => {
    const { deps, loads } = setup()
    const mp3 = await exportAudio(
      {
        input: mp3File(),
        source: { codec: 'mp3', container: 'mp3', media: 'audio' },
        format: 'original',
        tags: TAGS,
      },
      deps,
    )
    expect(id3Summary(await bytes(mp3.blob)).TALB).toBe('Album')
    const flac = await exportAudio(
      {
        input: flacFile(),
        source: { codec: 'flac', container: 'flac', media: 'audio' },
        format: 'flac',
        tags: TAGS,
      },
      deps,
    )
    expect(flac.plan.transcoded).toBe(false)
    const vorbis = await exportAudio(
      {
        input: oggVorbisFile(),
        source: { codec: 'vorbis', container: 'ogg', media: 'audio' },
        format: 'original',
        tags: TAGS,
      },
      deps,
    )
    expect(vorbis.tagged).toBe(true)
    expect(loads()).toBe(0)
  })

  it('saves the file untagged when its structure refuses the tags', async () => {
    const { deps } = setup()
    const broken = sineWav().subarray(0, 60)
    const result = await exportAudio(
      {
        input: broken,
        source: { codec: 'pcm', container: 'wav', media: 'audio' },
        format: 'original',
        tags: TAGS,
      },
      deps,
    )
    expect(result.tagged).toBe(false)
    expect(await bytes(result.blob)).toEqual(broken)
  })

  it('reports progress, ending at 1', async () => {
    const { deps } = setup()
    const progress: number[] = []
    await exportAudio(
      { input: oggOpusFile(), source: OPUS_WEBM, format: 'mp3', tags: TAGS },
      deps,
      (done) => progress.push(done),
    )
    expect(progress.at(-1)).toBe(1)
    expect(
      progress.every((value, index) => index === 0 || value >= (progress[index - 1] ?? 0)),
    ).toBe(true)
  })

  it('passes the core’s errors on', async () => {
    const { deps, core } = setup()
    core.failNext = new ConvertError('corrupt-input', 'Invalid data found when processing input')
    await expect(
      exportAudio({ input: new Uint8Array(4), source: OPUS_WEBM, format: 'mp3', tags: TAGS }, deps),
    ).rejects.toMatchObject({ code: 'corrupt-input' })
  })

  it('reports a video that isn’t an MP4 file as damaged', async () => {
    const { deps } = setup()
    await expect(
      exportAudio({ input: mp3File(), source: ITAG_18, format: 'original', tags: TAGS }, deps),
    ).rejects.toMatchObject({ name: 'ConvertError', code: 'corrupt-input' })
  })
})

describe('exportAudio with a core that never loads', () => {
  const neverLoads = {
    loadCore: async () => {
      throw new ConvertError('core-unavailable', "The ffmpeg core isn't available here: HTTP 404")
    },
  }
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 8, 7])

  it('saves an original WebM (YouTube’s itag 251) as it is, untagged', async () => {
    const progress: number[] = []
    const result = await exportAudio(
      { input: new Blob([webm as BlobPart]), source: OPUS_WEBM, format: 'original', tags: TAGS },
      neverLoads,
      (done) => progress.push(done),
    )
    expect(result).toMatchObject({ tagged: false, plan: { format: 'original' } })
    expect(result.blob.type).toBe('audio/webm')
    expect(await bytes(result.blob)).toEqual(webm)
    expect(progress.at(-1)).toBe(1)
  })

  it('saves an original WebM untagged when the core can’t remux it', async () => {
    const { deps, core } = setup()
    core.failNext = new ConvertError('failed', 'The ffmpeg core stopped', { cause: 'trap' })
    const result = await exportAudio(
      { input: webm, source: OPUS_WEBM, format: 'original', tags: TAGS },
      deps,
    )
    expect(result.tagged).toBe(false)
    expect(await bytes(result.blob)).toEqual(webm)
  })

  it('fails every format that needs the core, Opus in its own .opus file included', async () => {
    for (const format of ['opus', 'flac', 'mp3', 'wav', 'alac', 'aac'] as const) {
      await expect(
        exportAudio({ input: webm, source: OPUS_WEBM, format, tags: TAGS }, neverLoads),
        format,
      ).rejects.toMatchObject({ code: 'core-unavailable' })
    }
  })

  it('still saves the originals and same-format copies FXM tags itself', async () => {
    const m4a = await exportAudio(
      { input: fragmentedM4aFile(), source: AAC, format: 'original', tags: TAGS },
      neverLoads,
    )
    expect(m4a.tagged).toBe(true)
    const video = await exportAudio(
      { input: itag18File(), source: ITAG_18, format: 'aac', tags: TAGS },
      neverLoads,
    )
    expect(readMp4Tags(await bytes(video.blob))['©nam']).toBe('Song')
    const ogg = await exportAudio(
      {
        input: oggOpusFile(),
        source: { codec: 'opus', container: 'ogg', media: 'audio' },
        format: 'opus',
        tags: TAGS,
      },
      neverLoads,
    )
    expect(ogg.tagged).toBe(true)
  })

  it('never turns a cancellation into an untagged original', async () => {
    await expect(
      exportAudio(
        { input: webm, source: OPUS_WEBM, format: 'original', tags: TAGS },
        {
          loadCore: async () => {
            throw new ConvertError('cancelled', 'The conversion was cancelled')
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('inputExtension', () => {
  it('names the core’s input after its container', () => {
    expect(inputExtension({ container: 'webm', codec: 'opus' })).toBe('webm')
    expect(inputExtension({ container: 'mp4', codec: 'aac' })).toBe('m4a')
    expect(inputExtension({ container: 'ogg', codec: 'opus' })).toBe('opus')
    expect(inputExtension({ container: 'ogg', codec: 'vorbis' })).toBe('ogg')
  })
})
