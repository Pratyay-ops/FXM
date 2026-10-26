/**
 * Replays the committed labelled set offline and checks the committed report and the matching
 * config against it. Run with `-u` to write `REPORT.md` again after the set or the matcher
 * changed:
 *
 * ```sh
 * scripts/run.sh pnpm vitest run packages/core/src/matching/eval -u
 * ```
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { MATCHER_VERSION } from '../types'
import { splitOf } from './categories'
import { isAutoMatchAvailable, MATCHING_CONFIG } from './config'
import { evalConfigOf, optionsOf } from './evaluate'
import {
  labelTargets,
  parseCsv,
  REVIEW_COLUMNS,
  renderReviewCsv,
  reviewCell,
  reviewRows,
} from './labels'
import { withoutIsrcCap } from './recording'
import { replayMatch } from './replay'
import { autoPicksOf, buildReport, type EvalReport, renderReport } from './report'
import { casesOf, type EvalGroup, parseEvalGroup } from './types'

declare global {
  interface ImportMeta {
    /** Vite's glob import, as Vitest runs it. */
    glob<T = unknown>(
      pattern: string,
      options: { eager: true; import: 'default'; query?: '?raw' },
    ): Record<string, T>
  }
}

const files = import.meta.glob('./fixtures/groups/*.json', { eager: true, import: 'default' })
const groups: EvalGroup[] = Object.entries(files)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([, value]) => parseEvalGroup(value))

/** The committed review checklist. */
const reviewCsv = Object.values(
  import.meta.glob<string>('./REVIEW.csv', { eager: true, import: 'default', query: '?raw' }),
)[0]

/** The configuration the matching config ships: what the report evaluates. */
const shipped = evalConfigOf()

/**
 * Replaying the whole set takes a while: every input is matched once with the shipped settings
 * (about 1,600 replays for the full set, the uncapped ones included), at about 10 to 120 ms each
 * depending on the machine's load, and calibration replays its split for each of the grid's 24
 * settings when the defaults make a wrong Auto play there. The replays are shared between the
 * tests below.
 */
const REPLAY_TIMEOUT_MS = 30 * 60_000

describe('the labelled set', { timeout: REPLAY_TIMEOUT_MS }, () => {
  it('has a file per group, named after its ID', () => {
    expect(groups.length).toBeGreaterThan(0)
    for (const [path, value] of Object.entries(files)) {
      const id = (value as { id: string }).id
      expect(path).toBe(`./fixtures/groups/${id.replace(':', '-')}.json`)
    }
  })

  it("puts every group in its ID's split, so no group can move after it was seen", () => {
    for (const group of groups) expect(group.split, group.id).toBe(splitOf(group.id))
  })

  it('records every page each input asks for, with the cap and without', () => {
    for (const group of groups) {
      const recording = group.recording
      if (recording === undefined) continue
      for (const variant of group.variants) {
        const uncapped = withoutIsrcCap(variant.source)
        for (const source of uncapped === undefined
          ? [variant.source]
          : [variant.source, uncapped]) {
          const replay = replayMatch(source, recording, optionsOf(shipped))
          expect(replay.unrecorded, `${group.id}/${variant.slice}`).toEqual([])
        }
      }
    }
  })

  it('labels every candidate the report reads', () => {
    for (const group of groups) {
      for (const videoId of labelTargets(group, [optionsOf(shipped)])) {
        expect(group.labels?.[videoId], `${group.id} ${videoId}`).toBeDefined()
      }
    }
  })

  it('names where every input comes from', () => {
    for (const group of groups) {
      expect(group.provenance.length, group.id).toBeGreaterThan(0)
      expect(casesOf([group]).length, group.id).toBe(group.variants.length)
    }
  })
})

describe('the report', { timeout: REPLAY_TIMEOUT_MS }, () => {
  let report: EvalReport
  beforeAll(() => {
    report = buildReport(groups, shipped)
  }, REPLAY_TIMEOUT_MS)

  it('is the committed REPORT.md, replayed offline from the fixtures', async () => {
    await expect(renderReport(report)).toMatchFileSnapshot('./REPORT.md')
  })

  it("ships the calibration split's thresholds", () => {
    expect(shipped).toEqual(report.tuning.config)
  })

  it("has the review checklist of the set's labels (REVIEW.csv, decisions aside)", () => {
    expect(reviewCsv, 'REVIEW.csv next to this file').toBeDefined()
    // Compared as text after the checklist's escapes, whatever order or quoting a spreadsheet
    // left, and without the owner's decisions and notes, so a review in progress passes.
    const rows = (csv: string) => {
      const [header = [], ...body] = parseCsv(csv).map((fields) => fields.map(reviewCell))
      const blank = new Set([header.indexOf('decision'), header.indexOf('notes')])
      return {
        header,
        body: body
          .map((fields) => JSON.stringify(fields.map((value, at) => (blank.has(at) ? '' : value))))
          .sort(),
      }
    }
    const expected = rows(
      renderReviewCsv(reviewRows(groups, () => autoPicksOf(report.heldOut.outcomes))),
    )
    const committed = rows(reviewCsv ?? '')
    expect(committed.header).toEqual([...REVIEW_COLUMNS])
    expect(
      committed.body,
      "REVIEW.csv is out of date: run the recorder's label command (packages/sources/src/eval/README.md)",
    ).toEqual(expected.body)
  })

  it('turns Auto on only when the held-out gate passed and the owner finished the review', () => {
    if (MATCHING_CONFIG.auto) {
      expect(report.gate.failures).toEqual([])
      expect(report.review.complete).toBe(true)
    }
    expect(isAutoMatchAvailable()).toBe(MATCHING_CONFIG.auto && report.autoAllowed)
  })

  it('was made with this matcher', () => {
    expect(MATCHING_CONFIG.matcherVersion).toBe(MATCHER_VERSION)
    expect(report.matcherVersion).toBe(MATCHER_VERSION)
  })
})
