/**
 * The offline replay: runs the matching planner and engine on an input exactly as `runMatch`
 * does live, but answers every request from the group's recorded pages. No network, no clock.
 *
 * @module
 */

import { matchTrack } from '../engine'
import { addMatchResponse, nextMatchRequest } from '../plan'
import type { MatchOptions, MatchPages, MatchResult, MatchSource } from '../types'
import { answerFromRecording, isRecorded, pageKeys } from './recording'
import type { EvalRecording } from './types'

/** As many requests as `runMatch` makes at most. */
const MAX_REQUESTS = 12

/** What a replay found. */
export interface EvalReplay {
  /** The engine's decision, as `runMatch` would have returned it live. */
  result: MatchResult
  /** The requests the planner made, in order, as page keys (descriptions one key each). */
  requested: string[]
  /**
   * Pages the planner asked for that were never recorded: these options needed a page the
   * recorder's options did not. The result is `incomplete` then.
   */
  unrecorded: string[]
  /** Pages that were recorded as failures (`error`): skipped, as they were live. */
  failed: string[]
}

/**
 * Replays already made, by recording: a replay is deterministic, and the matcher is costly, so
 * the report, the labels and the tests share them. The key includes the number of pages, which
 * only ever grows while the recorder adds pages, so a replay never outlives its pages.
 */
const replays = new WeakMap<EvalRecording, Map<string, EvalReplay>>()

/**
 * Replays the match of `source` against a recording, with `options`. The loop is `runMatch`'s:
 * the planner asks for a page, the recording answers it (or not, which files the request as
 * skipped), until the planner is done; then the engine decides. Replays are kept per recording
 * and shared: treat the result as read-only.
 */
export function replayMatch(
  source: MatchSource,
  recording: EvalRecording,
  options: MatchOptions = {},
): EvalReplay {
  const key = `${Object.keys(recording.pages).length}\n${JSON.stringify([source, options])}`
  let kept = replays.get(recording)
  if (kept === undefined) {
    kept = new Map()
    replays.set(recording, kept)
  }
  const hit = kept.get(key)
  if (hit !== undefined) return hit
  const replay = runReplay(source, recording, options)
  kept.set(key, replay)
  return replay
}

/** One replay, as {@link replayMatch} describes it. */
function runReplay(
  source: MatchSource,
  recording: EvalRecording,
  options: MatchOptions,
): EvalReplay {
  let pages: MatchPages = {}
  const requested: string[] = []
  const unrecorded: string[] = []
  const failed: string[] = []
  let finished = false
  for (let count = 0; count < MAX_REQUESTS; count++) {
    const request = nextMatchRequest(source, pages, options)
    if (request === null) {
      finished = true
      break
    }
    const keys = pageKeys(request)
    requested.push(...keys)
    const response = answerFromRecording(request, recording)
    if (response === null) {
      for (const key of keys) {
        if (!isRecorded(recording, key)) unrecorded.push(key)
        else if ('error' in (recording.pages[key] ?? {})) failed.push(key)
      }
    }
    pages = addMatchResponse(pages, request, response)
  }
  const result = matchTrack(source, pages, options)
  const incomplete = !finished && nextMatchRequest(source, pages, options) !== null
  return {
    result: incomplete ? { ...result, incomplete: true } : result,
    requested,
    unrecorded,
    failed,
  }
}
