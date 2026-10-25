/**
 * InnerTube's formatted text: `{ runs: [{ text, navigationEndpoint }] }`, `{ simpleText }`, or a
 * view model's `{ content }`.
 *
 * @module
 */

import { asArray, asRecord, asString, type JsonRecord } from '../json'

/** One run of formatted text, with the link it carries, if any. */
export interface Run {
  /** The run's text, untrimmed. */
  readonly text: string
  /** Where the run links: its `navigationEndpoint`. */
  readonly endpoint?: JsonRecord
}

/** The runs of a formatted text, or none. */
export function runsOf(text: unknown): Run[] {
  const object = asRecord(text)
  if (object === undefined) return []
  if (Array.isArray(object.runs)) {
    const runs: Run[] = []
    for (const raw of asArray(object.runs)) {
      const run = asRecord(raw)
      const value = asString(run?.text)
      if (run === undefined || value === undefined) continue
      const endpoint = asRecord(run.navigationEndpoint)
      runs.push(endpoint === undefined ? { text: value } : { text: value, endpoint })
    }
    return runs
  }
  const simple = asString(object.simpleText) ?? asString(object.content)
  return simple === undefined ? [] : [{ text: simple }]
}

/** The plain text of a formatted text, trimmed, or `undefined` when it is empty. */
export function textOf(text: unknown): string | undefined {
  const value = runsOf(text)
    .map((run) => run.text)
    .join('')
    .trim()
  return value === '' ? undefined : value
}

/** A duration as YouTube writes it: `3:59`, `12:03` or `1:02:03`. */
const DURATION = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/u

/** Milliseconds in a duration such as `3:59`, or `undefined` when `text` is not one. */
export function parseDuration(text: string | undefined): number | undefined {
  const match = text === undefined ? null : DURATION.exec(text.trim())
  if (match === null) return undefined
  const [, hours = '0', minutes = '0', seconds = '0'] = match
  if (Number(seconds) > 59 || (hours !== '0' && Number(minutes) > 59)) return undefined
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
}

/** Whether `text` is a year such as `1993`. */
export function isYear(text: string): boolean {
  return /^[12]\d{3}$/u.test(text.trim())
}

/** A whole number written with optional thousands separators, e.g. `12` or `1,204`. */
const COUNT = /^(\d{1,3}(?:[,.   ]\d{3})+|\d+)$/u

/**
 * The count in a text such as `12 songs` or `61 tracks`, when the word after it is one of
 * `words` (in lower case). `undefined` for anything else, such as `34K views`.
 */
export function parseCount(text: string, words: readonly string[]): number | undefined {
  const [number, ...rest] = text.trim().split(/\s+/u)
  const word = rest.join(' ').toLowerCase()
  if (number === undefined || !COUNT.test(number) || !words.includes(word)) return undefined
  return Number(number.replace(/\D/gu, ''))
}
