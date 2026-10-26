/*
 * FXM's audio converter: the entry points of FXM's own ffmpeg core (tools/ffmpeg-wasm).
 *
 * The core is FFmpeg's libraries (LGPL-2.1-or-later) with LAME (LGPL-2.0-or-later) and Opus
 * (BSD-3-Clause), audio only, compiled to WebAssembly with Emscripten. The ffmpeg command-line
 * tool needs threads since FFmpeg 7, and threads in WebAssembly need a cross-origin isolated
 * page, which FXM can't be. So this file calls the libraries itself: one input file, its best
 * audio stream, one output file, either copied as it is (a remux) or decoded, resampled and
 * encoded again. Tags and cover art are written by FXM's TypeScript afterwards
 * (packages/convert), except the container tags of a remuxed WebM file, which only a muxer can
 * write.
 *
 * Entry points, called from JavaScript (packages/convert/src/core.ts):
 *
 *   int fxm_convert(const char *input, const char *output, const char *options)
 *       0, or a negative AVERROR code; fxm_last_error() then says what failed.
 *   const char *fxm_probe(const char *input)
 *       JSON about the input's best audio stream, or NULL.
 *   const char *fxm_version(void)
 *       JSON with the FFmpeg version, its licence and its configure line.
 *   const char *fxm_last_error(void), const char *fxm_log(void)
 *
 * options: one "key=value" per line, values percent-encoded (%0A for a newline, %25 for %):
 *
 *   format=<muxer>             flac, ipod, wav, mp3, ogg or webm
 *   codec=<encoder>|copy|pcm   an encoder name; copy keeps the audio as it is; pcm picks the
 *                              WAV encoder (16, 24 or 32 bits) that keeps the source's depth
 *   bitrate=<bits per second>  for lossy encoders
 *   compression_level=<n>      for FLAC
 *   metadata.<key>=<value>     a container tag, e.g. metadata.title=…
 *
 * Copyright 2026 the FXM authors. SPDX-License-Identifier: Apache-2.0
 */

#include <emscripten/emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/avstring.h>
#include <libavutil/channel_layout.h>
#include <libavutil/dict.h>
#include <libavutil/opt.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The most decoding errors a conversion skips before it gives up on the input. */
#define MAX_DECODE_ERRORS 100
/* Samples per encoder frame for encoders that take any frame size (PCM). */
#define VARIABLE_FRAME_SAMPLES 4096

static char last_error[1024];
static char log_text[8192];
static size_t log_length;
static char json[4096];

/* Reports progress to the JavaScript side: seconds converted, and the input's length. */
EM_JS(void, fxm_report_progress, (double done, double total), {
  if (typeof Module['onConvertProgress'] === 'function') Module['onConvertProgress'](done, total);
});

static void set_error(int code, const char *format, ...) {
  char reason[256];
  va_list args;
  va_start(args, format);
  vsnprintf(last_error, sizeof last_error, format, args);
  va_end(args);
  if (code < 0) {
    av_strerror(code, reason, sizeof reason);
    av_strlcatf(last_error, sizeof last_error, ": %s", reason);
  }
}

/* Keeps FFmpeg's warnings and errors for fxm_log(), the last 8 KiB of them. */
static void log_callback(void *context, int level, const char *format, va_list args) {
  char line[1024];
  int print_prefix = 1;
  if (level > av_log_get_level()) return;
  av_log_format_line2(context, level, format, args, line, sizeof line, &print_prefix);
  size_t length = strlen(line);
  if (length >= sizeof log_text) return;
  if (log_length + length >= sizeof log_text) {
    size_t keep = sizeof log_text / 2;
    memmove(log_text, log_text + log_length - keep, keep);
    log_length = keep;
  }
  memcpy(log_text + log_length, line, length);
  log_length += length;
  log_text[log_length] = '\0';
}

/* Appends `text` to json[] as a JSON string. */
static void json_string(size_t *at, const char *text) {
  size_t length = *at;
  const size_t room = sizeof json - 8;
  if (length < room) json[length++] = '"';
  for (const unsigned char *c = (const unsigned char *)(text ? text : ""); *c && length < room; c++) {
    if (*c == '"' || *c == '\\') {
      json[length++] = '\\';
      json[length++] = (char)*c;
    } else if (*c < 0x20) {
      length += (size_t)snprintf(json + length, sizeof json - length, "\\u%04x", *c);
    } else {
      json[length++] = (char)*c;
    }
  }
  if (length < sizeof json - 1) json[length++] = '"';
  json[length] = '\0';
  *at = length;
}

static void json_raw(size_t *at, const char *format, ...) {
  va_list args;
  if (*at >= sizeof json) return;
  va_start(args, format);
  int written = vsnprintf(json + *at, sizeof json - *at, format, args);
  va_end(args);
  if (written > 0) *at += (size_t)written;
  if (*at >= sizeof json) *at = sizeof json - 1;
}

/* Decodes %XX escapes in place. */
static void percent_decode(char *text) {
  char *out = text;
  for (char *in = text; *in; in++) {
    if (in[0] == '%' && in[1] && in[2]) {
      char hex[3] = {in[1], in[2], 0};
      char *end = NULL;
      long value = strtol(hex, &end, 16);
      if (end == hex + 2) {
        *out++ = (char)value;
        in += 2;
        continue;
      }
    }
    *out++ = *in;
  }
  *out = '\0';
}

typedef struct Options {
  char format[32];
  char codec[32];
  int64_t bit_rate;
  int compression_level;
  AVDictionary *metadata;
} Options;

static int parse_options(const char *text, Options *options) {
  memset(options, 0, sizeof *options);
  options->compression_level = -1;
  char *copy = av_strdup(text ? text : "");
  if (!copy) return AVERROR(ENOMEM);
  int ret = 0;
  char *save = NULL;
  for (char *line = strtok_r(copy, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
    char *equals = strchr(line, '=');
    if (!equals) continue;
    *equals = '\0';
    char *key = line, *value = equals + 1;
    percent_decode(value);
    if (!strcmp(key, "format")) {
      av_strlcpy(options->format, value, sizeof options->format);
    } else if (!strcmp(key, "codec")) {
      av_strlcpy(options->codec, value, sizeof options->codec);
    } else if (!strcmp(key, "bitrate")) {
      options->bit_rate = strtoll(value, NULL, 10);
    } else if (!strcmp(key, "compression_level")) {
      options->compression_level = (int)strtol(value, NULL, 10);
    } else if (!strncmp(key, "metadata.", 9) && key[9]) {
      ret = av_dict_set(&options->metadata, key + 9, value, 0);
      if (ret < 0) break;
    }
  }
  av_free(copy);
  if (ret >= 0 && (!options->format[0] || !options->codec[0])) {
    set_error(0, "options need a format and a codec");
    ret = AVERROR(EINVAL);
  }
  return ret;
}

typedef struct Job {
  Options options;
  AVFormatContext *input;
  AVFormatContext *output;
  AVStream *in_stream;
  AVStream *out_stream;
  AVCodecContext *decoder;
  AVCodecContext *encoder;
  const AVCodec *encoder_codec;
  SwrContext *resampler;
  /* The format the resampler was set up for, to notice when a stream changes mid-way. */
  enum AVSampleFormat resampler_in_format;
  int resampler_in_rate;
  AVChannelLayout resampler_in_layout;
  AVAudioFifo *fifo;
  AVFrame *frame;
  AVFrame *out_frame;
  AVPacket *packet;
  int64_t next_pts;
  int frames_decoded;
  int decode_errors;
  int header_written;
  double duration;
  double reported;
} Job;

static void report_progress(Job *job, const AVPacket *packet) {
  if (job->duration <= 0 || packet->pts == AV_NOPTS_VALUE) return;
  double done = packet->pts * av_q2d(job->in_stream->time_base);
  if (done - job->reported < job->duration / 200 && done < job->duration) return;
  job->reported = done;
  fxm_report_progress(done, job->duration);
}

static int open_input(Job *job, const char *path) {
  int ret = avformat_open_input(&job->input, path, NULL, NULL);
  if (ret < 0) {
    set_error(ret, "can't read the input");
    return ret;
  }
  ret = avformat_find_stream_info(job->input, NULL);
  if (ret < 0) {
    set_error(ret, "can't read the input's streams");
    return ret;
  }
  ret = av_find_best_stream(job->input, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
  if (ret < 0) {
    set_error(ret, "the input has no audio");
    return ret;
  }
  for (unsigned i = 0; i < job->input->nb_streams; i++) {
    if ((int)i != ret) job->input->streams[i]->discard = AVDISCARD_ALL;
  }
  job->in_stream = job->input->streams[ret];
  if (job->input->duration > 0) {
    job->duration = job->input->duration / (double)AV_TIME_BASE;
  } else if (job->in_stream->duration > 0) {
    job->duration = job->in_stream->duration * av_q2d(job->in_stream->time_base);
  }
  return 0;
}

static int open_output(Job *job, const char *path) {
  int ret = avformat_alloc_output_context2(&job->output, NULL, job->options.format, path);
  if (ret < 0 || !job->output) {
    set_error(ret < 0 ? ret : AVERROR_MUXER_NOT_FOUND, "no muxer for %s", job->options.format);
    return ret < 0 ? ret : AVERROR_MUXER_NOT_FOUND;
  }
  /* No "Lavf…" tags: the output depends on the input and the options only. */
  job->output->flags |= AVFMT_FLAG_BITEXACT;
  /* Container tags only where asked: the TypeScript side writes tags for the other formats. */
  av_dict_copy(&job->output->metadata, job->options.metadata, 0);
  return 0;
}

static int write_header(Job *job, const char *path) {
  AVDictionary *muxer_options = NULL;
  int ret;
  if (!(job->output->oformat->flags & AVFMT_NOFILE)) {
    ret = avio_open(&job->output->pb, path, AVIO_FLAG_WRITE);
    if (ret < 0) {
      set_error(ret, "can't create the output");
      return ret;
    }
  }
  if (!strcmp(job->options.format, "mp3")) {
    /* FXM writes the ID3v2 tag itself; no ID3v1 tag at the end. */
    av_dict_set(&muxer_options, "id3v2_version", "0", 0);
    av_dict_set(&muxer_options, "write_id3v1", "0", 0);
  }
  ret = avformat_write_header(job->output, &muxer_options);
  av_dict_free(&muxer_options);
  if (ret < 0) {
    set_error(ret, "can't start the %s file", job->options.format);
    return ret;
  }
  job->header_written = 1;
  return 0;
}

static int write_packet(Job *job, AVPacket *packet) {
  int ret = av_interleaved_write_frame(job->output, packet);
  if (ret < 0) set_error(ret, "can't write the output");
  return ret;
}

/* Samples at 48 kHz in an Opus packet, from its TOC byte (RFC 6716, section 3.1). */
static int opus_packet_samples(const uint8_t *data, int size) {
  static const int silk[4] = {480, 960, 1920, 2880};
  static const int celt[4] = {120, 240, 480, 960};
  if (size < 1) return 0;
  int config = data[0] >> 3, frame, count;
  if (config < 12) frame = silk[config & 3];
  else if (config < 16) frame = (config & 1) ? 960 : 480;
  else frame = celt[config & 3];
  switch (data[0] & 3) {
  case 0: count = 1; break;
  case 1:
  case 2: count = 2; break;
  default: count = size < 2 ? 0 : data[1] & 0x3f;
  }
  return frame * count;
}

/* Remux: the audio packets as they are, in another container. */
static int run_copy(Job *job, const char *output_path) {
  AVCodecParameters *parameters = job->in_stream->codecpar;
  int supported = avformat_query_codec(job->output->oformat, parameters->codec_id,
                                       FF_COMPLIANCE_NORMAL);
  if (supported == 0) {
    set_error(0, "%s files can't hold %s audio", job->options.format,
              avcodec_get_name(parameters->codec_id));
    return AVERROR(EINVAL);
  }
  job->out_stream = avformat_new_stream(job->output, NULL);
  if (!job->out_stream) return AVERROR(ENOMEM);
  int ret = avcodec_parameters_copy(job->out_stream->codecpar, parameters);
  if (ret < 0) return ret;
  job->out_stream->codecpar->codec_tag = 0;
  job->out_stream->time_base = job->in_stream->time_base;
  ret = write_header(job, output_path);
  if (ret < 0) return ret;
  int is_opus = parameters->codec_id == AV_CODEC_ID_OPUS;
  while ((ret = av_read_frame(job->input, job->packet)) >= 0) {
    if (job->packet->stream_index != job->in_stream->index) {
      av_packet_unref(job->packet);
      continue;
    }
    report_progress(job, job->packet);
    /* WebM leaves most Opus packets without a duration; Ogg's granule positions need it. */
    if (is_opus && job->packet->duration <= 0) {
      int samples = opus_packet_samples(job->packet->data, job->packet->size);
      job->packet->duration =
          av_rescale_q(samples, (AVRational){1, 48000}, job->in_stream->time_base);
    }
    av_packet_rescale_ts(job->packet, job->in_stream->time_base, job->out_stream->time_base);
    job->packet->stream_index = job->out_stream->index;
    job->packet->pos = -1;
    ret = write_packet(job, job->packet);
    if (ret < 0) return ret;
  }
  if (ret != AVERROR_EOF) {
    set_error(ret, "can't read the input");
    return ret;
  }
  return 0;
}

/* How many bits per sample the source's samples carry: 16, 24 or 32. */
static int source_depth(const Job *job, enum AVSampleFormat format) {
  int raw = job->decoder->bits_per_raw_sample;
  switch (av_get_packed_sample_fmt(format)) {
  case AV_SAMPLE_FMT_U8:
  case AV_SAMPLE_FMT_S16: return 16;
  case AV_SAMPLE_FMT_S32:
  case AV_SAMPLE_FMT_S64: return raw > 0 && raw <= 24 ? (raw <= 16 ? 16 : 24) : 32;
  default: {
    /* Floats: a lossless source (float WAV) keeps 24 bits; lossy audio needs no more than 16. */
    const AVCodecDescriptor *descriptor = avcodec_descriptor_get(job->decoder->codec_id);
    return descriptor && (descriptor->props & AV_CODEC_PROP_LOSSLESS) ? 24 : 16;
  }
  }
}

static int is_lossless_encoder(const AVCodec *codec) {
  const AVCodecDescriptor *descriptor = avcodec_descriptor_get(codec->id);
  return descriptor && (descriptor->props & AV_CODEC_PROP_LOSSLESS);
}

/* The encoder's sample format: the source's depth for lossless encoders, floats if possible. */
static enum AVSampleFormat choose_sample_format(const AVCodec *codec, int depth) {
  const enum AVSampleFormat *formats = NULL;
  int count = 0;
  if (avcodec_get_supported_config(NULL, codec, AV_CODEC_CONFIG_SAMPLE_FORMAT, 0,
                                   (const void **)&formats, &count) < 0 ||
      !formats || count == 0) {
    return AV_SAMPLE_FMT_FLTP;
  }
  static const enum AVSampleFormat lossy[] = {AV_SAMPLE_FMT_FLTP, AV_SAMPLE_FMT_FLT,
                                              AV_SAMPLE_FMT_S32P, AV_SAMPLE_FMT_S32,
                                              AV_SAMPLE_FMT_S16P, AV_SAMPLE_FMT_S16};
  static const enum AVSampleFormat deep[] = {AV_SAMPLE_FMT_S32, AV_SAMPLE_FMT_S32P,
                                             AV_SAMPLE_FMT_S16, AV_SAMPLE_FMT_S16P};
  static const enum AVSampleFormat shallow[] = {AV_SAMPLE_FMT_S16, AV_SAMPLE_FMT_S16P,
                                                AV_SAMPLE_FMT_S32, AV_SAMPLE_FMT_S32P};
  const enum AVSampleFormat *order = lossy;
  size_t length = sizeof lossy / sizeof *lossy;
  if (is_lossless_encoder(codec)) {
    order = depth > 16 ? deep : shallow;
    length = 4;
  }
  for (size_t i = 0; i < length; i++) {
    for (int j = 0; j < count; j++) {
      if (formats[j] == order[i]) return order[i];
    }
  }
  return formats[0];
}

/* The input's rate when the encoder takes it, else the nearest rate above it, else below. */
static int choose_sample_rate(const AVCodec *codec, int input) {
  const int *rates = NULL;
  int count = 0;
  if (avcodec_get_supported_config(NULL, codec, AV_CODEC_CONFIG_SAMPLE_RATE, 0,
                                   (const void **)&rates, &count) < 0 ||
      !rates || count == 0) {
    return input;
  }
  int above = 0, below = 0;
  for (int i = 0; i < count; i++) {
    if (rates[i] == input) return input;
    if (rates[i] > input && (!above || rates[i] < above)) above = rates[i];
    if (rates[i] < input && rates[i] > below) below = rates[i];
  }
  return above ? above : below;
}

/* The input's layout when the encoder takes it, else one with as many channels, else stereo. */
static int choose_layout(const AVCodec *codec, const AVChannelLayout *input,
                         AVChannelLayout *chosen) {
  const AVChannelLayout *layouts = NULL;
  int count = 0;
  if (avcodec_get_supported_config(NULL, codec, AV_CODEC_CONFIG_CHANNEL_LAYOUT, 0,
                                   (const void **)&layouts, &count) < 0 ||
      !layouts || count == 0) {
    return av_channel_layout_copy(chosen, input);
  }
  for (int i = 0; i < count; i++) {
    if (!av_channel_layout_compare(&layouts[i], input)) {
      return av_channel_layout_copy(chosen, &layouts[i]);
    }
  }
  for (int i = 0; i < count; i++) {
    if (layouts[i].nb_channels == input->nb_channels) {
      return av_channel_layout_copy(chosen, &layouts[i]);
    }
  }
  for (int i = 0; i < count; i++) {
    if (layouts[i].nb_channels == 2) return av_channel_layout_copy(chosen, &layouts[i]);
  }
  return av_channel_layout_copy(chosen, &layouts[0]);
}

/* The frame's layout, with an order the resampler understands. */
static int frame_layout(const AVFrame *frame, AVChannelLayout *layout) {
  if (frame->ch_layout.order == AV_CHANNEL_ORDER_UNSPEC) {
    av_channel_layout_default(layout, frame->ch_layout.nb_channels);
    return 0;
  }
  return av_channel_layout_copy(layout, &frame->ch_layout);
}

static int setup_resampler(Job *job, const AVFrame *frame) {
  AVChannelLayout in_layout = {0};
  int ret = frame_layout(frame, &in_layout);
  if (ret < 0) return ret;
  swr_free(&job->resampler);
  ret = swr_alloc_set_opts2(&job->resampler, &job->encoder->ch_layout, job->encoder->sample_fmt,
                            job->encoder->sample_rate, &in_layout, frame->format,
                            frame->sample_rate, 0, NULL);
  if (ret >= 0) {
    enum AVSampleFormat out = av_get_packed_sample_fmt(job->encoder->sample_fmt);
    enum AVSampleFormat in = av_get_packed_sample_fmt(frame->format);
    /* Dither when fewer bits leave than arrive, as when float audio becomes 16-bit WAV. */
    if (out == AV_SAMPLE_FMT_S16 && in != AV_SAMPLE_FMT_S16 && in != AV_SAMPLE_FMT_U8) {
      av_opt_set_int(job->resampler, "dither_method", SWR_DITHER_TRIANGULAR, 0);
    }
    ret = swr_init(job->resampler);
  }
  if (ret < 0) {
    set_error(ret, "can't convert the samples");
  } else {
    job->resampler_in_format = frame->format;
    job->resampler_in_rate = frame->sample_rate;
    av_channel_layout_uninit(&job->resampler_in_layout);
    ret = av_channel_layout_copy(&job->resampler_in_layout, &frame->ch_layout);
  }
  av_channel_layout_uninit(&in_layout);
  return ret;
}

/* Opens the encoder, the output and the resampler for the first decoded frame. */
static int open_encoder(Job *job, const AVFrame *frame, const char *output_path) {
  const AVCodec *codec = job->encoder_codec;
  int depth = source_depth(job, frame->format);
  if (!codec) {
    /* codec=pcm: WAV that keeps the source's depth. */
    const char *name = depth == 16 ? "pcm_s16le" : depth == 24 ? "pcm_s24le" : "pcm_s32le";
    codec = avcodec_find_encoder_by_name(name);
    if (!codec) {
      set_error(AVERROR_ENCODER_NOT_FOUND, "no %s encoder", name);
      return AVERROR_ENCODER_NOT_FOUND;
    }
  }
  job->encoder = avcodec_alloc_context3(codec);
  if (!job->encoder) return AVERROR(ENOMEM);
  AVCodecContext *encoder = job->encoder;
  AVChannelLayout in_layout = {0};
  int ret = frame_layout(frame, &in_layout);
  if (ret < 0) return ret;
  ret = choose_layout(codec, &in_layout, &encoder->ch_layout);
  av_channel_layout_uninit(&in_layout);
  if (ret < 0) return ret;
  encoder->sample_fmt = choose_sample_format(codec, depth);
  encoder->sample_rate = choose_sample_rate(codec, frame->sample_rate);
  if (is_lossless_encoder(codec) &&
      av_get_packed_sample_fmt(encoder->sample_fmt) == AV_SAMPLE_FMT_S32) {
    encoder->bits_per_raw_sample = depth > 24 && codec->id == AV_CODEC_ID_PCM_S32LE ? 32 : 24;
  }
  encoder->time_base = (AVRational){1, encoder->sample_rate};
  if (job->options.bit_rate > 0 && !is_lossless_encoder(codec)) {
    encoder->bit_rate = job->options.bit_rate;
  }
  if (job->options.compression_level >= 0) {
    encoder->compression_level = job->options.compression_level;
  }
  if (job->output->oformat->flags & AVFMT_GLOBALHEADER) {
    encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  }
  encoder->flags |= AV_CODEC_FLAG_BITEXACT;
  AVDictionary *encoder_options = NULL;
  if (codec->id == AV_CODEC_ID_OPUS) av_dict_set(&encoder_options, "application", "audio", 0);
  ret = avcodec_open2(encoder, codec, &encoder_options);
  av_dict_free(&encoder_options);
  if (ret < 0) {
    set_error(ret, "can't start the %s encoder", codec->name);
    return ret;
  }
  job->out_stream = avformat_new_stream(job->output, NULL);
  if (!job->out_stream) return AVERROR(ENOMEM);
  ret = avcodec_parameters_from_context(job->out_stream->codecpar, encoder);
  if (ret < 0) return ret;
  job->out_stream->time_base = encoder->time_base;
  job->fifo = av_audio_fifo_alloc(encoder->sample_fmt, encoder->ch_layout.nb_channels, 1);
  if (!job->fifo) return AVERROR(ENOMEM);
  ret = setup_resampler(job, frame);
  if (ret < 0) return ret;
  return write_header(job, output_path);
}

static int drain_encoder(Job *job) {
  for (;;) {
    int ret = avcodec_receive_packet(job->encoder, job->packet);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
    if (ret < 0) {
      set_error(ret, "the %s encoder failed", job->encoder->codec->name);
      return ret;
    }
    av_packet_rescale_ts(job->packet, job->encoder->time_base, job->out_stream->time_base);
    job->packet->stream_index = job->out_stream->index;
    ret = write_packet(job, job->packet);
    if (ret < 0) return ret;
  }
}

/* Encodes whole frames from the FIFO; with `flush`, the rest too. */
static int encode_fifo(Job *job, int flush) {
  AVCodecContext *encoder = job->encoder;
  int variable = !encoder->frame_size ||
                 (encoder->codec->capabilities & AV_CODEC_CAP_VARIABLE_FRAME_SIZE);
  int frame_size = variable ? VARIABLE_FRAME_SAMPLES : encoder->frame_size;
  while (av_audio_fifo_size(job->fifo) >= frame_size ||
         (flush && av_audio_fifo_size(job->fifo) > 0)) {
    int samples = FFMIN(av_audio_fifo_size(job->fifo), frame_size);
    int padded = samples;
    if (samples < frame_size && !variable &&
        !(encoder->codec->capabilities & AV_CODEC_CAP_SMALL_LAST_FRAME)) {
      padded = frame_size;
    }
    AVFrame *frame = job->out_frame;
    av_frame_unref(frame);
    frame->nb_samples = padded;
    frame->format = encoder->sample_fmt;
    frame->sample_rate = encoder->sample_rate;
    int ret = av_channel_layout_copy(&frame->ch_layout, &encoder->ch_layout);
    if (ret >= 0) ret = av_frame_get_buffer(frame, 0);
    if (ret < 0) return ret;
    if (padded > samples) {
      av_samples_set_silence(frame->extended_data, samples, padded - samples,
                             encoder->ch_layout.nb_channels, encoder->sample_fmt);
    }
    if (av_audio_fifo_read(job->fifo, (void **)frame->extended_data, samples) < samples) {
      return AVERROR(EIO);
    }
    frame->pts = job->next_pts;
    job->next_pts += padded;
    ret = avcodec_send_frame(encoder, frame);
    if (ret < 0) {
      set_error(ret, "the %s encoder refused the audio", encoder->codec->name);
      return ret;
    }
    ret = drain_encoder(job);
    if (ret < 0) return ret;
  }
  return 0;
}

/* Converts `frame` (or, with NULL, what the resampler still holds) into the FIFO. */
static int resample(Job *job, const AVFrame *frame) {
  int capacity = swr_get_out_samples(job->resampler, frame ? frame->nb_samples : 0);
  if (capacity <= 0) return 0;
  uint8_t **buffers = NULL;
  int ret = av_samples_alloc_array_and_samples(&buffers, NULL, job->encoder->ch_layout.nb_channels,
                                               capacity, job->encoder->sample_fmt, 0);
  if (ret < 0) return ret;
  int converted = swr_convert(job->resampler, buffers, capacity,
                              frame ? (const uint8_t **)frame->extended_data : NULL,
                              frame ? frame->nb_samples : 0);
  if (converted > 0 && av_audio_fifo_write(job->fifo, (void **)buffers, converted) < converted) {
    converted = AVERROR(ENOMEM);
  }
  av_freep(&buffers[0]);
  av_freep(&buffers);
  if (converted < 0) set_error(converted, "can't convert the samples");
  return converted;
}

static int flush_resampler(Job *job) {
  int ret;
  do {
    ret = resample(job, NULL);
  } while (ret > 0);
  return ret;
}

static int receive_frames(Job *job, const char *output_path) {
  for (;;) {
    int ret = avcodec_receive_frame(job->decoder, job->frame);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
    if (ret < 0) {
      set_error(ret, "the %s decoder failed", job->decoder->codec->name);
      return ret;
    }
    job->frames_decoded++;
    if (!job->encoder) {
      ret = open_encoder(job, job->frame, output_path);
    } else if (job->frame->format != job->resampler_in_format ||
               job->frame->sample_rate != job->resampler_in_rate ||
               av_channel_layout_compare(&job->frame->ch_layout, &job->resampler_in_layout)) {
      /* The stream changed mid-way (HE-AAC, a chained Ogg file): resample from the new format. */
      ret = flush_resampler(job);
      if (ret >= 0) ret = setup_resampler(job, job->frame);
    }
    if (ret >= 0) ret = resample(job, job->frame);
    av_frame_unref(job->frame);
    if (ret >= 0) ret = encode_fifo(job, 0);
    if (ret < 0) return ret;
  }
}

/* Transcode: decode, resample, encode. */
static int run_encode(Job *job, const char *output_path) {
  const AVCodec *decoder = avcodec_find_decoder(job->in_stream->codecpar->codec_id);
  if (!decoder) {
    set_error(AVERROR_DECODER_NOT_FOUND, "FXM can't decode %s audio",
              avcodec_get_name(job->in_stream->codecpar->codec_id));
    return AVERROR_DECODER_NOT_FOUND;
  }
  job->decoder = avcodec_alloc_context3(decoder);
  if (!job->decoder) return AVERROR(ENOMEM);
  int ret = avcodec_parameters_to_context(job->decoder, job->in_stream->codecpar);
  if (ret < 0) return ret;
  job->decoder->pkt_timebase = job->in_stream->time_base;
  ret = avcodec_open2(job->decoder, decoder, NULL);
  if (ret < 0) {
    set_error(ret, "can't start the %s decoder", decoder->name);
    return ret;
  }
  if (strcmp(job->options.codec, "pcm") != 0) {
    job->encoder_codec = avcodec_find_encoder_by_name(job->options.codec);
    if (!job->encoder_codec) {
      set_error(AVERROR_ENCODER_NOT_FOUND, "no %s encoder", job->options.codec);
      return AVERROR_ENCODER_NOT_FOUND;
    }
  }
  while ((ret = av_read_frame(job->input, job->packet)) >= 0) {
    if (job->packet->stream_index != job->in_stream->index) {
      av_packet_unref(job->packet);
      continue;
    }
    report_progress(job, job->packet);
    ret = avcodec_send_packet(job->decoder, job->packet);
    av_packet_unref(job->packet);
    if (ret == AVERROR_INVALIDDATA && ++job->decode_errors <= MAX_DECODE_ERRORS) continue;
    if (ret < 0 && ret != AVERROR(EAGAIN)) {
      set_error(ret, "the %s decoder refused the input", decoder->name);
      return ret;
    }
    ret = receive_frames(job, output_path);
    if (ret < 0) return ret;
  }
  if (ret != AVERROR_EOF) {
    set_error(ret, "can't read the input");
    return ret;
  }
  ret = avcodec_send_packet(job->decoder, NULL);
  if (ret >= 0) ret = receive_frames(job, output_path);
  if (ret < 0) return ret;
  if (!job->encoder) {
    set_error(AVERROR_INVALIDDATA, "the input holds no audio FXM can decode");
    return AVERROR_INVALIDDATA;
  }
  ret = flush_resampler(job);
  if (ret >= 0) ret = encode_fifo(job, 1);
  if (ret < 0) return ret;
  ret = avcodec_send_frame(job->encoder, NULL);
  if (ret < 0) return ret;
  return drain_encoder(job);
}

static void close_job(Job *job) {
  if (job->output) {
    if (job->output->pb) avio_closep(&job->output->pb);
    avformat_free_context(job->output);
  }
  avformat_close_input(&job->input);
  avcodec_free_context(&job->decoder);
  avcodec_free_context(&job->encoder);
  swr_free(&job->resampler);
  av_channel_layout_uninit(&job->resampler_in_layout);
  if (job->fifo) av_audio_fifo_free(job->fifo);
  av_frame_free(&job->frame);
  av_frame_free(&job->out_frame);
  av_packet_free(&job->packet);
  av_dict_free(&job->options.metadata);
}

static void start_logging(void) {
  last_error[0] = '\0';
  log_text[0] = '\0';
  log_length = 0;
  av_log_set_level(AV_LOG_WARNING);
  av_log_set_callback(log_callback);
}

EMSCRIPTEN_KEEPALIVE int fxm_convert(const char *input_path, const char *output_path,
                                     const char *options) {
  Job job = {0};
  start_logging();
  int ret = parse_options(options, &job.options);
  if (ret < 0) goto end;
  job.frame = av_frame_alloc();
  job.out_frame = av_frame_alloc();
  job.packet = av_packet_alloc();
  if (!job.frame || !job.out_frame || !job.packet) {
    ret = AVERROR(ENOMEM);
    set_error(ret, "out of memory");
    goto end;
  }
  ret = open_input(&job, input_path);
  if (ret >= 0) ret = open_output(&job, output_path);
  if (ret < 0) goto end;
  ret = strcmp(job.options.codec, "copy") == 0 ? run_copy(&job, output_path)
                                               : run_encode(&job, output_path);
  if (ret >= 0) {
    ret = av_write_trailer(job.output);
    if (ret < 0) set_error(ret, "can't finish the %s file", job.options.format);
  }
  if (ret >= 0 && job.duration > 0) fxm_report_progress(job.duration, job.duration);
end:
  if (ret < 0 && !last_error[0]) set_error(ret, "the conversion failed");
  close_job(&job);
  return ret < 0 ? ret : 0;
}

EMSCRIPTEN_KEEPALIVE const char *fxm_probe(const char *input_path) {
  Job job = {0};
  start_logging();
  if (open_input(&job, input_path) < 0) {
    close_job(&job);
    return NULL;
  }
  const AVCodecParameters *parameters = job.in_stream->codecpar;
  const char *sample_format = av_get_sample_fmt_name(parameters->format);
  size_t at = 0;
  json_raw(&at, "{\"format\":");
  json_string(&at, job.input->iformat->name);
  json_raw(&at, ",\"codec\":");
  json_string(&at, avcodec_get_name(parameters->codec_id));
  json_raw(&at, ",\"sampleRate\":%d,\"channels\":%d,\"bitsPerRawSample\":%d", parameters->sample_rate,
           parameters->ch_layout.nb_channels, parameters->bits_per_raw_sample);
  json_raw(&at, ",\"bitRate\":%lld,\"durationSeconds\":%.6f,\"sampleFormat\":",
           (long long)parameters->bit_rate, job.duration);
  json_string(&at, sample_format ? sample_format : "");
  json_raw(&at, ",\"streams\":%u}", job.input->nb_streams);
  close_job(&job);
  return json;
}

EMSCRIPTEN_KEEPALIVE const char *fxm_version(void) {
  size_t at = 0;
  json_raw(&at, "{\"ffmpeg\":");
  json_string(&at, av_version_info());
  json_raw(&at, ",\"license\":");
  json_string(&at, avcodec_license());
  json_raw(&at, ",\"formatLicense\":");
  json_string(&at, avformat_license());
  json_raw(&at, ",\"utilLicense\":");
  json_string(&at, avutil_license());
  json_raw(&at, ",\"resampleLicense\":");
  json_string(&at, swresample_license());
  json_raw(&at, ",\"configuration\":");
  json_string(&at, avcodec_configuration());
  json_raw(&at, "}");
  return json;
}

EMSCRIPTEN_KEEPALIVE const char *fxm_last_error(void) { return last_error; }

EMSCRIPTEN_KEEPALIVE const char *fxm_log(void) { return log_text; }
