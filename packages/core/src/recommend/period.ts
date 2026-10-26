/**
 * Periods for lists that stay put for a while: the Daily Mixes change once a day and Discover
 * once a week. A period has a key (`2026-10-26`, `2026-W44`), and a random source seeded with
 * that key gives the same "random" choices all through the period and new ones in the next.
 *
 * Days and weeks follow the user's clock: pass the offset of local time from UTC, which core
 * cannot know (`-new Date().getTimezoneOffset()` in a browser). Weeks are ISO 8601 weeks, which
 * start on Monday.
 *
 * @module
 */

import { createSeededRandom, type RandomSource } from '../queue/random'

/** A period after which a list changes. */
export type Period = 'day' | 'week'

const DAY_MS = 24 * 60 * 60 * 1000

/** Zero-pads a number to two digits. */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** `now` shifted to local time, as a `Date` read through its UTC fields. */
function localDate(now: number, utcOffsetMinutes: number): Date {
  const offset = Number.isFinite(utcOffsetMinutes) ? utcOffsetMinutes : 0
  return new Date((Number.isFinite(now) ? now : 0) + offset * 60_000)
}

/**
 * The key of the period `now` falls in, in local time: `YYYY-MM-DD` for a day, the ISO week
 * `YYYY-Www` for a week (its year is the year of the week's Thursday).
 */
export function periodKey(period: Period, now: number, utcOffsetMinutes = 0): string {
  const date = localDate(now, utcOffsetMinutes)
  if (period === 'day') {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  }
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  const weekday = (date.getUTCDay() + 6) % 7 // Monday = 0
  const thursday = new Date(day + (3 - weekday) * DAY_MS)
  const year = thursday.getUTCFullYear()
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1
  return `${year}-W${pad(week)}`
}

/** The 32-bit FNV-1a hash of a string: a stable seed for {@link seededRandomFor}. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * A random source seeded with `parts` (joined), e.g. `seededRandomFor('discover', '2026-W44')`:
 * the same parts always give the same sequence.
 */
export function seededRandomFor(...parts: readonly string[]): RandomSource {
  return createSeededRandom(hashSeed(parts.join('|')))
}
