/**
 * Conversion and tagging (stage 4.2): saving a download in the format the user wants, with
 * honest labels, tags, cover art and lyrics, through FXM's own LGPL ffmpeg core in a worker.
 * The worker's side is `@fxm/convert/worker`; fakes and generated test audio are in
 * `@fxm/convert/testing`. See the README.
 *
 * @module
 */

export {
  type Converter,
  type ConverterOptions,
  type ConverterWorker,
  createConverter,
  type ExportJobOptions,
  type ExportOutcome,
} from './client'
export {
  CORE_FILES,
  type CoreFileSystem,
  type CoreLoaderOptions,
  type CoreModule,
  type CoreModuleFactory,
  type CoreProbe,
  type CoreVersion,
  coreOptions,
  createCore,
  errorCodeOf,
  type FfmpegCore,
  loadFfmpegCore,
} from './core'
export {
  type FetchCoverOptions,
  fetchCover,
  type ImageInfo,
  MAX_COVER_BYTES,
  sniffImage,
} from './cover'
export {
  containerTags,
  type ExporterDependencies,
  type ExportRequest,
  type ExportResult,
  exportAudio,
  withSourceTags,
} from './exporter'
export { demuxMp4Audio, type Mp4AudioTrack, type Mp4Sample } from './mp4/demux'
export { writeM4a } from './mp4/write'
export { exportFileName, MAX_NAME_BYTES } from './naming'
export {
  type CoreJob,
  type CoreMuxer,
  ENCODE_KBPS,
  type ExportChoice,
  type ExportOptions,
  type ExportOutput,
  type ExportPlan,
  exportChoices,
  exportExtension,
  exportLabel,
  exportMimeType,
  FLAC_COMPRESSION_LEVEL,
  isExportable,
  planExport,
  sourceLabel,
  type TagWriter,
} from './plan'
export type { ConverterReply, ConverterRequest, ExportJob } from './protocol'
export {
  type BrowserSaverEnvironment,
  createBrowserDeviceSaver,
  type DeviceSaver,
  type SaveRequest,
  type SaveTarget,
} from './save'
export {
  conversionNote,
  SOURCE_BITRATE_TAG,
  SOURCE_CODEC_TAG,
} from './tags/fields'
export { writeFlacTags } from './tags/flac'
export { buildId3v2, stripId3v2, writeMp3Tags } from './tags/id3v2'
export { type OggTagResult, writeOggTags } from './tags/ogg'
export { writeWavTags } from './tags/riff'
export { type TrackTagExtras, tagsFromTrack } from './track-tags'
export {
  ConvertError,
  type ConvertErrorCode,
  type ConvertedFrom,
  type CoverArt,
  type ExportTags,
  isConvertError,
  type SourceAudio,
  type TimedLyric,
} from './types'
