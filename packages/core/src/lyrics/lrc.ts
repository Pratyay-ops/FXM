/**
 * LRC lyrics: {@link parseLrc} reads LRC (or plain text) into {@link Lyrics}, and
 * {@link serializeLrc} writes them back as LRC.
 *
 * What the parser understands:
 *
 * - **Line timestamps** `[mm:ss.xx]`, with any number of fraction digits (`[mm:ss]`,
 *   `[mm:ss.x]`, `[mm:ss.xxx]`), `:` as the fraction separator (`[mm:ss:xx]`, so a third part
 *   is never hours), minutes past 99 and spaces inside the brackets. A minus sign is read as
 *   time zero.
 * - **Several timestamps on one line**, `[00:12.00][01:30.00]Chorus`: one line per timestamp,
 *   all sorted by time.
 * - **`[offset:±ms]`**, anywhere in the file (the last one wins). As the LRC convention says, a
 *   positive offset shows the lyrics sooner: every time becomes `time − offset`, at least zero.
 * - **ID tags** on a line of their own: `[ti:]`, `[ar:]`, `[al:]` and `[length:]` become
 *   {@link LyricsMetadata}; the other LRC tags (`[au:]`, `[by:]`, `[re:]`, `[tool:]`, `[ve:]`,
 *   `[la:]`, `[id:]`, `[#:]`) are skipped. Bracketed text that is not one of them, such as
 *   `[Chorus]` or `[Verse 1: Artist]`, stays lyrics.
 * - **Enhanced LRC** word timing, `[00:12.00]<00:12.00>When <00:12.50>the <00:13.10>truth`, as
 *   `LyricLine.words`. Text before the first word timestamp starts with the line. A word
 *   timestamp followed by no text marks where the word before it ends (`LyricWord.endMs`).
 *   On a line with several line timestamps, the word times belong to the one nearest the first
 *   word, and the copies at the other timestamps are shifted with them.
 * - **Formatting:** CRLF, CR or LF line breaks, a byte order mark, blank lines and spaces around
 *   text.
 *
 * A file with at least one timed line gives synced lyrics: untimed text lines are dropped, and a
 * timed line without text is kept as an empty line, which marks a pause. A file without timed
 * lines is plain text: every line is kept, with runs of blank lines folded into one empty line
 * (a stanza break) and none at either end.
 *
 * @module
 */

import type { LyricLine, Lyrics, LyricsMetadata, LyricWord } from '../providers'

/** A timestamp: sign, minutes, seconds and an optional fraction after `.` or `:`. */
const TIME = String.raw`(-?)(\d+):(\d{1,2})(?:[.:](\d+))?`
/** A line timestamp at the start of the text: `[00:12.34]`. */
const LINE_STAMP = new RegExp(String.raw`^\[\s*${TIME}\s*\]`, 'u')
/** An enhanced-LRC word timestamp: `<00:12.34>`. */
const WORD_STAMP = new RegExp(String.raw`<\s*${TIME}\s*>`, 'gu')
/** A line that is one ID tag, `[ar:Radiohead]`. The value runs to the last `]` of the line. */
const ID_TAG = /^\[\s*([a-z]+|#)\s*:(.*)\]$/iu
/** The LRC ID tags. Only these are taken for tags; other bracketed text stays lyrics. */
const ID_TAGS: ReadonlySet<string> = new Set([
  'ti',
  'ar',
  'al',
  'length',
  'offset',
  'au',
  'by',
  're',
  'tool',
  've',
  'la',
  'lang',
  'id',
  '#',
])
/** A `[length:]` value: `03:58`, `3:58.64`. */
const LENGTH = new RegExp(`^${TIME}$`, 'u')
/** An offset value in milliseconds: `+500`, `-250`, `120`. */
const OFFSET = /^[+-]?\d+(?:\.\d+)?$/u
/** Any line break. */
const LINE_BREAK = /\r\n|\r|\n/u

/** Milliseconds from a match of {@link TIME}: its four captures are its only ones. */
function timeFrom(match: RegExpExecArray): number {
  const [, sign, minutes, seconds, fraction] = match
  const ms =
    (Number(minutes) * 60 + Number(seconds)) * 1000 +
    (fraction === undefined ? 0 : Math.round(Number(`0.${fraction}`) * 1000))
  return sign === '-' ? -ms : ms
}

/** The timestamps at the start of a line, and the text after them. */
function lineStamps(line: string): { times: number[]; rest: string } {
  const times: number[] = []
  let rest = line
  for (let match = LINE_STAMP.exec(rest); match !== null; match = LINE_STAMP.exec(rest)) {
    times.push(timeFrom(match))
    rest = rest.slice(match[0].length).trimStart()
  }
  return { times, rest }
}

/** A piece of an enhanced line: a word timestamp and the text up to the next one. */
interface Segment {
  /** The word timestamp, or `undefined` for text before the first one. */
  timeMs: number | undefined
  /** The text as written, spaces included. */
  raw: string
}

/** Splits a line's text at its word timestamps, or returns `null` when it has none. */
function wordSegments(text: string): Segment[] | null {
  const segments: Segment[] = []
  let time: number | undefined
  let from = 0
  for (const match of text.matchAll(WORD_STAMP)) {
    const raw = text.slice(from, match.index)
    if (time !== undefined || raw.trim() !== '') segments.push({ timeMs: time, raw })
    time = timeFrom(match)
    from = match.index + match[0].length
  }
  if (time === undefined) return null
  segments.push({ timeMs: time, raw: text.slice(from) })
  return segments
}

/**
 * The words of one copy of an enhanced line that starts at `lineTimeMs`, with the word times
 * moved by `shiftMs`. Spaces become one trailing space on the word before them.
 */
function wordsOf(segments: readonly Segment[], lineTimeMs: number, shiftMs: number): LyricWord[] {
  const words: LyricWord[] = []
  let spaceAfter = false
  for (const { timeMs, raw } of segments) {
    const text = raw.replace(/\s+/gu, ' ').trim()
    const previous = words.at(-1)
    if (text === '') {
      // A timestamp without a word ends the word before it; its spaces still separate words.
      if (previous !== undefined && timeMs !== undefined) previous.endMs = timeMs + shiftMs
      if (raw !== '') spaceAfter = true
      continue
    }
    if (previous !== undefined && (spaceAfter || /^\s/u.test(raw))) previous.text += ' '
    words.push({ timeMs: timeMs === undefined ? lineTimeMs : timeMs + shiftMs, text })
    spaceAfter = /\s$/u.test(raw)
  }
  return words
}

/** The time in `times` nearest to `target`, the first one on a tie. */
function nearest(times: readonly number[], target: number): number {
  let best = times[0] ?? target
  for (const time of times) if (Math.abs(time - target) < Math.abs(best - target)) best = time
  return best
}

/** A line of synced lyrics, which always has a start time. */
type TimedLine = LyricLine & { timeMs: number }

/** The lines for a text that carries the line timestamps `times`. */
function timedLines(text: string, times: readonly number[]): TimedLine[] {
  const segments = wordSegments(text)
  if (segments === null) return times.map((timeMs) => ({ timeMs, text }))
  const firstWordMs = segments.find((segment) => segment.timeMs !== undefined)?.timeMs ?? 0
  const reference = nearest(times, firstWordMs)
  return times.map((timeMs) => {
    const words = wordsOf(segments, timeMs, timeMs - reference)
    if (words.length === 0) return { timeMs, text: '' }
    return { timeMs, text: words.map((word) => word.text).join(''), words }
  })
}

/** Moves a time by the file's offset, never below zero. */
function shifted(timeMs: number, offsetMs: number): number {
  return Math.max(0, timeMs - offsetMs)
}

/** A word with the file's offset applied. An end that is not after the start is dropped. */
function shiftedWord(word: LyricWord, offsetMs: number): LyricWord {
  const timeMs = shifted(word.timeMs, offsetMs)
  const endMs = word.endMs === undefined ? timeMs : shifted(word.endMs, offsetMs)
  return endMs > timeMs ? { timeMs, text: word.text, endMs } : { timeMs, text: word.text }
}

/** Applies the offset to every time and sorts the lines by time (stable, so ties keep order). */
function finishSynced(lines: readonly TimedLine[], offsetMs: number): TimedLine[] {
  return lines
    .map((line): TimedLine => {
      const timeMs = shifted(line.timeMs, offsetMs)
      if (line.words === undefined) return { timeMs, text: line.text }
      const words = line.words.map((word) => shiftedWord(word, offsetMs))
      return { timeMs, text: line.text, words }
    })
    .sort((a, b) => a.timeMs - b.timeMs)
}

/** Plain-text lines: runs of blank lines fold into one empty line, none at either end. */
function plainLines(texts: readonly string[]): LyricLine[] {
  const lines: LyricLine[] = []
  for (const text of texts) {
    if (text === '' && (lines.length === 0 || lines.at(-1)?.text === '')) continue
    lines.push({ text })
  }
  if (lines.at(-1)?.text === '') lines.pop()
  return lines
}

/** Milliseconds from a `[length:]` value such as `03:58` or `3:58.64`. */
function parseLength(value: string): number | undefined {
  const match = LENGTH.exec(value)
  return match === null || match[1] === '-' ? undefined : timeFrom(match)
}

/** Records one ID tag in `metadata`. Returns the offset when the tag is a valid `[offset:]`. */
function readTag(metadata: LyricsMetadata, key: string, value: string): number | undefined {
  if (value === '') return undefined
  switch (key) {
    case 'ti':
      metadata.title = value
      break
    case 'ar':
      metadata.artist = value
      break
    case 'al':
      metadata.album = value
      break
    case 'length': {
      const lengthMs = parseLength(value)
      if (lengthMs !== undefined) metadata.lengthMs = lengthMs
      break
    }
    case 'offset':
      return OFFSET.test(value) ? Math.round(Number(value)) : undefined
  }
  return undefined
}

/**
 * Parses LRC text into {@link Lyrics}: synced when at least one line has a timestamp, plain
 * otherwise. See the module documentation for everything it understands. It never throws: any
 * text gives lyrics, possibly without lines.
 *
 * Every time in the result already includes the file's `[offset:]`, so the lines are in time
 * order and `lineAt` can search them as they are.
 *
 * @param text LRC or plain text, e.g. LRCLIB's `syncedLyrics` or `plainLyrics`.
 * @param source Where the lyrics came from, for {@link Lyrics.source}.
 */
export function parseLrc(text: string, source = 'lrc'): Lyrics {
  const metadata: LyricsMetadata = {}
  let offsetMs = 0
  const timed: TimedLine[] = []
  const untimed: string[] = []
  const input = typeof text === 'string' ? text.replace(/^﻿/u, '') : ''
  for (const rawLine of input.split(LINE_BREAK)) {
    const line = rawLine.trim()
    const tag = ID_TAG.exec(line)
    const key = tag?.[1]?.toLowerCase()
    if (tag !== null && key !== undefined && ID_TAGS.has(key)) {
      offsetMs = readTag(metadata, key, (tag[2] ?? '').trim()) ?? offsetMs
      continue
    }
    const { times, rest } = lineStamps(line)
    if (times.length === 0) untimed.push(line)
    else timed.push(...timedLines(rest, times))
  }
  const synced = timed.length > 0
  const lyrics: Lyrics = {
    synced,
    lines: synced ? finishSynced(timed, offsetMs) : plainLines(untimed),
    source,
  }
  if (Object.keys(metadata).length > 0) lyrics.metadata = metadata
  return lyrics
}

/**
 * A time as an LRC timestamp without brackets: `mm:ss.xx`, or `mm:ss.xxx` when the time is not
 * a whole number of hundredths, so that every whole millisecond survives a round trip. Negative
 * times, and times that are not finite numbers, are written as zero.
 */
function formatTime(timeMs: number): string {
  const total = Number.isFinite(timeMs) ? Math.max(0, Math.round(timeMs)) : 0
  const minutes = String(Math.floor(total / 60_000)).padStart(2, '0')
  const seconds = String(Math.floor(total / 1000) % 60).padStart(2, '0')
  const ms = total % 1000
  const fraction = ms % 10 === 0 ? String(ms / 10).padStart(2, '0') : String(ms).padStart(3, '0')
  return `${minutes}:${seconds}.${fraction}`
}

/** Text that fits on one LRC line: line breaks become spaces. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/gu, ' ')
}

/** A timed line's text after its timestamp, with word timestamps when it has words. */
function lineBody(line: LyricLine): string {
  if (line.words === undefined || line.words.length === 0) return oneLine(line.text).trim()
  return line.words
    .map((word) => {
      const text = oneLine(word.text)
      const core = text.trimEnd()
      const end = word.endMs === undefined ? '' : `<${formatTime(word.endMs)}>`
      return `<${formatTime(word.timeMs)}>${core}${end}${text.slice(core.length)}`
    })
    .join('')
}

/**
 * Writes lyrics as LRC text, one line per {@link LyricLine}, ending with a line break (or
 * empty when there is nothing to write). {@link parseLrc} reads the result back to equal lyrics:
 *
 * - metadata first, as `[ti:]`, `[ar:]`, `[al:]` and `[length:]`;
 * - synced lyrics as `[mm:ss.xx]text`, with `<mm:ss.xx>` word timestamps for lines that have
 *   words (written from the words, which make up the text), and a closing word timestamp for
 *   each word with an `endMs`. Lines without a start time (or with one that is not a finite
 *   number) cannot be written and are left out;
 * - plain lyrics as their text, an empty line for each stanza break.
 *
 * Times are already offset, so no `[offset:]` is written. Line breaks inside a text become
 * spaces.
 */
export function serializeLrc(lyrics: Lyrics): string {
  const out: string[] = []
  const { metadata } = lyrics
  if (metadata?.title) out.push(`[ti:${oneLine(metadata.title).trim()}]`)
  if (metadata?.artist) out.push(`[ar:${oneLine(metadata.artist).trim()}]`)
  if (metadata?.album) out.push(`[al:${oneLine(metadata.album).trim()}]`)
  const lengthMs = metadata?.lengthMs
  if (lengthMs !== undefined && Number.isFinite(lengthMs)) {
    out.push(`[length:${formatTime(lengthMs)}]`)
  }
  for (const line of lyrics.lines) {
    if (!lyrics.synced) out.push(oneLine(line.text).trim())
    else if (Number.isFinite(line.timeMs)) {
      out.push(`[${formatTime(line.timeMs ?? 0)}]${lineBody(line)}`)
    }
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}
