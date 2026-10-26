/**
 * Which line, and which word, of synced lyrics is sung at a moment of playback.
 *
 * @module
 */

import type { LyricLine, Lyrics } from '../providers'

/**
 * The last index in `[0, count)` whose start is at or before `timeMs`, by binary search over
 * starts in time order; -1 when there is none, or when `timeMs` is not a number.
 */
function lastStartedAt(count: number, startOf: (index: number) => number, timeMs: number): number {
  let low = 0
  let high = Number.isNaN(timeMs) ? -1 : count - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (startOf(middle) <= timeMs) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/**
 * The index of the line sung at `timeMs` (milliseconds into the track): the last line that
 * starts at or before it, found by binary search, so it is cheap to call on every frame. It
 * stays on the last line after the end, and lines that start together (a duet) resolve to the
 * last of them.
 *
 * Returns -1 before the first line, for a time that is not a number, and always for unsynced
 * lyrics. Expects the lines in time order, as `parseLrc` returns them. A line without a start
 * time, which `parseLrc` never returns in synced lyrics, starts with the line before it.
 */
export function lineAt(lyrics: Lyrics, timeMs: number): number {
  if (!lyrics.synced) return -1
  const { lines } = lyrics
  const startOf = (index: number): number => {
    for (let i = index; i >= 0; i--) {
      const start = lines[i]?.timeMs
      if (start !== undefined) return start
    }
    return Number.NEGATIVE_INFINITY
  }
  return lastStartedAt(lines.length, startOf, timeMs)
}

/**
 * The index of the word of `line` sung at `timeMs`: the last word that starts at or before it,
 * for karaoke-style highlighting. A word lasts until its `endMs`, or else until the next word
 * starts, so a highlight can show progress through it.
 *
 * Returns -1 before the first word, for a time that is not a number, and for a line without
 * word timing.
 */
export function wordAt(line: LyricLine, timeMs: number): number {
  const words = line.words ?? []
  const startOf = (index: number) => words[index]?.timeMs ?? Number.NEGATIVE_INFINITY
  return lastStartedAt(words.length, startOf, timeMs)
}
