/**
 * Test helpers for conversion (`@fxm/convert/testing`): audio files the tests generate
 * themselves (sine waves, silence and filler, never real recordings) and a fake ffmpeg core.
 *
 * @module
 */

export {
  aacSampleEntry,
  aacSamples,
  type FlacOptions,
  filler,
  flacFile,
  fragmentedM4aFile,
  itag18File,
  type Mp3Options,
  m4aFile,
  mp3File,
  type OggOptions,
  oggOpusFile,
  oggPage,
  oggVorbisFile,
  riff,
  riffChunk,
  type SineOptions,
  sineWav,
  vorbisComments,
} from './audio'
export {
  createInProcessConverter,
  FAKE_WEBM_MAGIC,
  type FakeCoreCall,
  FakeFfmpegCore,
} from './fake-core'
export {
  type Id3Frame,
  id3Summary,
  id3TextFrame,
  type OggPageInfo,
  readFlacBlocks,
  readId3v2,
  readMp4Tags,
  readOggPackets,
  readOggPages,
  readRiffChunks,
  readVorbisComments,
  topLevelBoxes,
} from './inspect'
