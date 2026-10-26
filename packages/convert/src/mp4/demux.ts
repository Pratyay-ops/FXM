/**
 * Reads the audio track of an MP4 file with mp4box.js (BSD-3-Clause): YouTube's itag 18 (a
 * 360p video whose AAC track FXM keeps), YouTube's fragmented M4A audio, and the M4A files the
 * ffmpeg core writes. What it returns is enough to write the audio alone into a new file
 * (write.ts), never the video: Spotube's downloads came out as video files (its issue #3085).
 *
 * @module
 */

import { createFile, Log, MP4BoxBuffer } from 'mp4box'
import { ConvertError } from '../types'

/** One audio sample (an AAC or ALAC frame): its bytes and its duration in media time. */
export interface Mp4Sample {
  readonly data: Uint8Array
  readonly duration: number
}

/** An MP4 file's audio track, ready to be written on its own. */
export interface Mp4AudioTrack {
  /** The sample entry's type: `mp4a` (AAC) or `alac`. */
  readonly type: string
  /** The sample entry box, byte for byte: `mp4a` with its `esds`, or `alac` with its cookie. */
  readonly sampleEntry: Uint8Array
  /** The track's media timescale (`mdhd`), in units per second. */
  readonly timescale: number
  /** The movie's timescale (`mvhd`). */
  readonly movieTimescale: number
  readonly samples: readonly Mp4Sample[]
  /**
   * Where playback starts in media time, from a single-entry edit list: the encoder's priming
   * samples, which a player skips (AAC's 1024 or 2112). Absent without such an edit list.
   */
  readonly mediaTime?: number
}

/** Audio sample entries FXM keeps: AAC and ALAC. */
const AUDIO_TYPES: ReadonlySet<string> = new Set(['mp4a', 'alac'])

// What FXM reads of mp4box.js's boxes; its own types are much wider.
interface SampleEntryBox {
  readonly type: string
  readonly start: number
  readonly size: number
}
interface TrackBox {
  readonly mdia: {
    readonly mdhd: { readonly timescale: number }
    readonly hdlr: { readonly handler: string }
    readonly minf: { readonly stbl: { readonly stsd: { readonly entries: SampleEntryBox[] } } }
  }
  readonly edts?: {
    readonly elst?: { readonly entries: { readonly media_time: number }[] }
  }
}
interface Mp4BoxSample {
  readonly data?: Uint8Array
  readonly duration: number
}
interface Mp4BoxFile {
  onError?: (module: string, message: string) => void
  onReady?: (info: { tracks: { id: number; type?: string; codec: string }[] }) => void
  onSamples?: (id: number, user: unknown, samples: Mp4BoxSample[]) => void
  appendBuffer(buffer: MP4BoxBuffer): number
  setExtractionOptions(id: number, user?: unknown, options?: { nbSamples?: number }): void
  start(): void
  flush(): void
  getTrackById(id: number): TrackBox | undefined
  readonly moov?: { readonly mvhd?: { readonly timescale: number } }
}

let quiet = false

/**
 * The audio track of an MP4 file: its sample entry, timescales, samples and edit list.
 *
 * @throws ConvertError `corrupt-input` when the file isn't a readable MP4 file or holds no audio
 * samples, `unsupported-input` when its audio isn't AAC or ALAC. A RangeError means memory ran
 * out (the one copy of the file this makes).
 */
export function demuxMp4Audio(bytes: Uint8Array): Mp4AudioTrack {
  if (!quiet) {
    // mp4box.js logs every box it doesn't know to the console.
    Log.setLogLevel(Log.error)
    quiet = true
  }
  const file = createFile() as unknown as Mp4BoxFile
  let failure: string | undefined
  let ready = false
  let trackId: number | undefined
  const samples: Mp4Sample[] = []
  file.onError = (_module, message) => {
    failure = message
  }
  file.onReady = (info) => {
    ready = true
    for (const track of info.tracks) {
      const box = file.getTrackById(track.id)
      const entry = box?.mdia.minf.stbl.stsd.entries[0]
      if (box?.mdia.hdlr.handler === 'soun' && entry && AUDIO_TYPES.has(entry.type)) {
        trackId = track.id
        break
      }
    }
    if (trackId === undefined) return
    file.onSamples = (_id, _user, batch) => {
      for (const sample of batch) {
        if (sample.data) samples.push({ data: sample.data, duration: sample.duration })
      }
    }
    file.setExtractionOptions(trackId, undefined, { nbSamples: 1000 })
    file.start()
  }
  // One copy, into the buffer type mp4box.js parses (it starts at byte 0 of the file).
  const buffer = new MP4BoxBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  file.appendBuffer(buffer)
  file.flush()
  if (failure !== undefined) {
    throw new ConvertError('corrupt-input', `Not a readable MP4 file: ${failure}`)
  }
  if (!ready) throw new ConvertError('corrupt-input', 'Not a readable MP4 file: no movie box')
  if (trackId === undefined) {
    throw new ConvertError('unsupported-input', 'The MP4 file has no AAC or ALAC track')
  }
  const box = file.getTrackById(trackId) as TrackBox
  const entry = box.mdia.minf.stbl.stsd.entries[0] as SampleEntryBox
  if (samples.length === 0) {
    throw new ConvertError('corrupt-input', 'The MP4 file holds no audio samples')
  }
  const edits = box.edts?.elst?.entries
  const mediaTime =
    edits?.length === 1 && (edits[0]?.media_time ?? -1) > 0 ? edits[0]?.media_time : undefined
  return {
    type: entry.type,
    sampleEntry: bytes.slice(entry.start, entry.start + entry.size),
    timescale: box.mdia.mdhd.timescale,
    movieTimescale: file.moov?.mvhd?.timescale ?? box.mdia.mdhd.timescale,
    samples,
    ...(mediaTime === undefined ? {} : { mediaTime }),
  }
}
