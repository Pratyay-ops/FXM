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
})

describe('inputExtension', () => {
  it('names the core’s input after its container', () => {
    expect(inputExtension({ container: 'webm', codec: 'opus' })).toBe('webm')
    expect(inputExtension({ container: 'mp4', codec: 'aac' })).toBe('m4a')
    expect(inputExtension({ container: 'ogg', codec: 'opus' })).toBe('opus')
    expect(inputExtension({ container: 'ogg', codec: 'vorbis' })).toBe('ogg')
  })
})
