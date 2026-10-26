import { describe, expect, it } from 'vitest'
import { DEFAULT_EVAL_CONFIG, evaluateCase, optionsOf } from './evaluate'
import { pickKey } from './labels'
import { autoPicksOf, buildReport, EVAL_GATE, renderReport } from './report'
import { group, item, label, source } from './testing'
import { tuneThresholds } from './tune'
import {
  casesOf,
  EVAL_CATEGORIES,
  type EvalGroup,
  type EvalLabelEntry,
  type EvalSplit,
} from './types'

/** A text-only match that auto-plays: right or wrong as labelled, or unlabelled. */
function textOnly(id: string, split: EvalSplit, verdict?: 'exact' | 'wrong'): EvalGroup {
  return group({
    id,
    split,
    variants: [{ slice: 'spotify', source: source('Song', 'Artist', 200) }],
    items: { x: item('Song', 'Artist', 200, { album: 'Other Album' }) },
    pages: { 'songs/Artist Song': { items: ['x'] } },
    ...(verdict === undefined ? {} : { labels: { x: label(verdict) } }),
  })
}

/** An ISRC hit. */
function isrcHit(id: string, split: EvalSplit): EvalGroup {
  return group({
    id,
    split,
    variants: [{ slice: 'spotify', source: source('Hit', 'Band', 180, { isrc: 'USAAA0000001' }) }],
    items: { h: item('Hit', 'Band', 180, { album: 'LP' }) },
    pages: { 'isrc-songs/1/USAAA0000001': { items: ['h'] } },
    labels: { h: label('exact') },
    spotify: { id: 'hit' },
    musicBrainz: {
      exact: { recording: 'mbid', title: 'Hit', artists: ['Band'], isrcs: ['USAAA0000001'] },
    },
  })
}

/** A trusted ISRC that misses, and a text match the cap keeps at Suggest. */
function isrcMiss(id: string, split: EvalSplit): EvalGroup {
  return group({
    id,
    split,
    categories: ['spotify-singles'],
    variants: [
      { slice: 'spotify', source: source('Tune', 'Singer', 190, { isrc: 'USMIS0000001' }) },
      {
        slice: 'data-export',
        source: source('Tune', 'Singer', 190, {
          isrc: 'USMIS0000001',
          isrcOrigin: 'musicbrainz-exact',
        }),
      },
    ],
    items: { m: item('Tune', 'Singer', 190, { album: 'Tune' }), f: item('Filler', 'Nobody', 100) },
    pages: {
      'isrc-songs/1/USMIS0000001': { items: ['f'] },
      'isrc-top-card/USMIS0000001': { item: null },
      'isrc-songs/2/USMIS0000001': { items: ['f'] },
      'songs/Singer Tune': { items: ['m'] },
    },
    labels: { m: label('exact'), f: label('wrong') },
    spotify: { id: 'miss' },
    musicBrainz: { exact: null },
  })
}

/** One track whose four inputs all play the same video without asking. */
function fourInputs(id: string): EvalGroup {
  const isrc = 'USAAA0000001'
  return group({
    id,
    variants: [
      { slice: 'spotify', source: source('Hit', 'Band', 180, { isrc }) },
      {
        slice: 'data-export',
        source: source('Hit', 'Band', 180, { isrc, isrcOrigin: 'musicbrainz-exact' }),
      },
      {
        slice: 'musicbrainz-exact',
        source: source('Hit', 'Band', 180, { isrc, isrcOrigin: 'musicbrainz-exact' }),
      },
      {
        slice: 'musicbrainz-fuzzy',
        source: source('Hit', 'Band', 180, { isrc, isrcOrigin: 'musicbrainz-fuzzy' }),
      },
    ],
    items: { h: item('Hit', 'Band', 180, { album: 'LP' }) },
    pages: { [`isrc-songs/1/${isrc}`]: { items: ['h'] }, 'songs/Band Hit': { items: ['h'] } },
    labels: { h: label('exact') },
  })
}

/**
 * A held-out set that passes the gate: 200 mainstream ISRC hits, the owner's spot check of 10 %
 * of their labels, and nothing ambiguous.
 */
function passingSet(): EvalGroup[] {
  return Array.from({ length: 200 }, (_, index) => {
    const hit = isrcHit(`sp:pass-${String(index).padStart(3, '0')}`, 'held-out')
    if (index < 20) {
      hit.labels = {
        h: {
          label: 'exact',
          by: 'owner',
          evidence: ['test', 'owner confirmed the draft (exact, rule)'],
          reviewed: '2026-10-30',
          draft: { label: 'exact', by: 'rule' },
        },
      }
    }
    return hit
  })
}

describe('evaluateCase', () => {
  it('replays a case with the Auto setting on and reads the label of its pick', () => {
    const [evalCase] = casesOf([textOnly('sp:w', 'held-out', 'wrong')])
    if (evalCase === undefined) throw new Error('no case')
    expect(evaluateCase(evalCase, DEFAULT_EVAL_CONFIG)).toMatchObject({
      caseId: 'sp:w/spotify',
      band: 'auto',
      pick: 'x',
      label: 'wrong',
      isrc: 'no-isrc',
      trustedIsrc: false,
      categories: ['mainstream'],
      incomplete: false,
      gaps: [],
      isrcLedByOther: false,
    })
    const strict = evaluateCase(evalCase, { thresholds: {}, requireReleaseAgreement: true })
    expect(strict.band).toBe('suggest')
    expect(strict.blockers).toContain('release-agreement-required')
  })

  it('replays a missed trusted ISRC without the cap too', () => {
    const [evalCase] = casesOf([isrcMiss('sp:m', 'held-out')])
    if (evalCase === undefined) throw new Error('no case')
    const outcome = evaluateCase(evalCase, DEFAULT_EVAL_CONFIG)
    expect(outcome).toMatchObject({ band: 'suggest', isrc: 'miss', trustedIsrc: true })
    expect(outcome.isrcLedByOther).toBe(true)
    expect(outcome.uncapped).toEqual({ band: 'auto', pick: 'm', label: 'exact' })
  })

  it('names the pages a replay lacked', () => {
    const broken = group({
      variants: [
        { slice: 'spotify', source: source('Song', 'Artist', 200, { isrc: 'USERR0000001' }) },
      ],
      items: { x: item('Song', 'Artist', 200, { album: 'Other Album' }) },
      pages: {
        'isrc-songs/1/USERR0000001': { error: 'NotFound' },
        'songs/Artist Song': { items: ['x'] },
      },
      labels: { x: label('exact') },
    })
    const [evalCase] = casesOf([broken])
    if (evalCase === undefined) throw new Error('no case')
    expect(evaluateCase(evalCase, DEFAULT_EVAL_CONFIG)).toMatchObject({
      band: 'auto',
      incomplete: true,
      gaps: ['isrc-songs/1/USERR0000001'],
    })
  })

  it('gives the recorder its first option set for the defaults, so they share replays', () => {
    expect(optionsOf(DEFAULT_EVAL_CONFIG)).toEqual({ auto: true, mode: 'music' })
    expect(optionsOf({ thresholds: { auto: 0.9 }, requireReleaseAgreement: true })).toEqual({
      auto: true,
      mode: 'music',
      requireReleaseAgreement: true,
      thresholds: { auto: 0.9 },
    })
  })
})

describe('buildReport', () => {
  const groups = [
    textOnly('sp:wrong', 'held-out', 'wrong'),
    textOnly('sp:unlabelled', 'held-out'),
    isrcHit('sp:hit', 'held-out'),
    isrcMiss('sp:miss', 'held-out'),
    isrcHit('sp:calibration', 'calibration'),
  ]
  const report = buildReport(groups, DEFAULT_EVAL_CONFIG)

  it('counts wrong and unlabelled Auto plays per category, and fails the gate on them', () => {
    const mainstream = report.heldOut.categories.find((row) => row.name === 'mainstream')
    expect(mainstream).toMatchObject({ cases: 3, auto: 3, wrongAuto: 1, unlabeledAuto: 1 })
    expect(report.heldOut.badAuto.map((outcome) => outcome.caseId)).toEqual([
      'sp:wrong/spotify',
      'sp:unlabelled/spotify',
    ])
    expect(report.gate.passed).toBe(false)
    expect(report.gate.failures).toEqual(
      expect.arrayContaining(['1 wrong Auto plays', '1 unlabelled Auto plays']),
    )
    expect(report.gate.upperBound).toBeUndefined()
    expect(report.autoAllowed).toBe(false)
  })

  it('measures the ISRC-miss cap per category, data-export rows and slices included', () => {
    const singles = report.heldOut.isrcCap.find((row) => row.name === 'spotify-singles')
    expect(singles).toMatchObject({
      cases: 1,
      trusted: 1,
      misses: 1,
      ledByOther: 1,
      auto: 0,
      autoUncapped: 1,
    })
    expect(singles?.wrongPrevented).toBe(0)
    const dataExport = report.heldOut.isrcCap.find((row) => row.name === 'data-export')
    expect(dataExport).toMatchObject({ cases: 1, trusted: 1, misses: 1, autoUncapped: 1 })
    const bySlice = report.heldOut.isrcCapBySlice.find((row) => row.name === 'data-export')
    expect(bySlice).toEqual({ ...dataExport, name: 'data-export' })
    const all = report.heldOut.coverage.find((row) => row.name === 'all')
    expect(all).toMatchObject({ tracks: 2, linked: 1, oneIsrc: 1, agrees: 1 })
  })

  it('bounds the wrong-Auto rate per track when none is wrong', () => {
    const clean = buildReport([isrcHit('sp:a', 'held-out'), isrcHit('sp:b', 'held-out')])
    expect(clean.gate).toMatchObject({ wrongAuto: 0, autoGroups: 2, autoPlays: 2 })
    expect(clean.gate.upperBound).toBeCloseTo(1 - 0.05 ** (1 / 2), 10)
    expect(clean.gate.failures).toContain(
      `2 held-out groups, fewer than ${EVAL_GATE.minHeldOutGroups}`,
    )
  })

  it('counts one trial per track, however many of its inputs auto-play', () => {
    const one = buildReport([fourInputs('sp:four')])
    expect(one.heldOut.outcomes.filter((outcome) => outcome.band === 'auto')).toHaveLength(4)
    expect(one.gate).toMatchObject({ autoPlays: 4, autoGroups: 1, wrongAuto: 0 })
    expect(one.gate.upperBound).toBeCloseTo(0.95, 10)
    expect(one.gate.failures).toContain(
      `1 tracks with an Auto play, fewer than ${EVAL_GATE.minAutoGroups}`,
    )
    expect(renderReport(one)).toContain('0 of 4 Auto plays, on 1 tracks')
  })

  it('fails the gate on an Auto play whose replay lacked a page, and lists the case', () => {
    const broken = group({
      id: 'sp:broken',
      variants: [
        { slice: 'spotify', source: source('Song', 'Artist', 200, { isrc: 'USERR0000001' }) },
      ],
      items: { x: item('Song', 'Artist', 200, { album: 'Other Album' }) },
      pages: {
        'isrc-songs/1/USERR0000001': { error: 'NotFound' },
        'songs/Artist Song': { items: ['x'] },
      },
      labels: { x: label('exact') },
    })
    const incomplete = buildReport([broken])
    expect(incomplete.gate.incompleteAuto).toBe(1)
    expect(incomplete.gate.failures).toContain('1 Auto plays whose replay lacked a page')
    expect(incomplete.heldOut.incomplete.map((outcome) => outcome.caseId)).toEqual([
      'sp:broken/spotify',
    ])
    expect(renderReport(incomplete)).toContain(
      '- sp:broken/spotify (auto): isrc-songs/1/USERR0000001',
    )
  })

  it('fails the gate when calibration finds no safe setting', () => {
    const squatter = group({
      id: 'sp:squat',
      split: 'calibration',
      variants: [
        { slice: 'spotify', source: source('Hit', 'Band', 180, { isrc: 'USAAA0000001' }) },
      ],
      items: { h: item('Hit', 'Band', 180, { album: 'LP' }) },
      pages: { 'isrc-songs/1/USAAA0000001': { items: ['h'] } },
      labels: { h: label('wrong') },
    })
    const unsafe = buildReport([...passingSet(), squatter])
    expect(unsafe.tuning.safe).toBe(0)
    expect(unsafe.gate.passed).toBe(false)
    expect(unsafe.gate.failures).toEqual([
      'calibration found no setting without a wrong Auto play (of 24 tried)',
    ])
    expect(renderReport(unsafe)).toContain('the gate fails until one is safe')
  })

  it('renders every category, also those without a case', () => {
    const text = renderReport(report)
    const heldOut = text.slice(text.indexOf('## Held-out split'), text.indexOf('Per input slice'))
    for (const name of EVAL_CATEGORIES) expect(heldOut).toContain(`| ${name} |`)
    expect(heldOut).toContain('| long-tail | 0 | – | 0 | – | – | – | 0 |')
  })

  it('renders the same Markdown every time, saying Auto stays off', () => {
    const text = renderReport(report)
    expect(renderReport(buildReport(groups, DEFAULT_EVAL_CONFIG))).toBe(text)
    expect(text).toContain('**Auto setting: OFF.**')
    expect(text).toContain('- sp:wrong/spotify: x (wrong)')
    expect(text).toContain('The set is not complete yet')
  })
})

describe('the gate passed', () => {
  const groups = passingSet()
  const report = buildReport(groups, DEFAULT_EVAL_CONFIG)

  it('lets the config turn Auto on once the held-out gate passed and the review is complete', () => {
    expect(report.gate).toMatchObject({
      passed: true,
      failures: [],
      groups: 200,
      autoGroups: 200,
      wrongAuto: 0,
      incompleteAuto: 0,
      mainstreamGroups: 200,
      mainstreamAutoRate: 1,
    })
    expect(report.gate.upperBound).toBeCloseTo(1 - 0.05 ** (1 / 200), 10)
    expect(report.review).toMatchObject({
      complete: true,
      certain: 200,
      spotChecksRequired: 20,
      spotChecked: 20,
      overturned: 0,
      pending: 0,
    })
    expect(report.autoAllowed).toBe(true)
    const text = renderReport(report)
    expect(text).toContain('**Auto setting: may be ON.**')
    expect(text).toContain('Held-out gate: **passed**.')
    expect(text).not.toContain('The set is not complete yet')
  })

  it('keeps Auto off after an overturned spot check until the Auto plays are checked', () => {
    // The owner overturned a certain label the rules drafted: the filler of one group, which
    // no input plays, so the gate still passes.
    const overturn = (checkAll: boolean) =>
      groups.map((hit, index) => {
        const reviewed: EvalLabelEntry = {
          label: 'exact',
          by: 'owner',
          evidence: ['test'],
          reviewed: '2026-10-31',
          draft: { label: 'exact', by: 'rule' },
        }
        const labels: Record<string, EvalLabelEntry> = {
          ...hit.labels,
          ...(checkAll ? { h: reviewed } : {}),
        }
        if (index === 0) {
          labels.f = {
            label: 'exact',
            by: 'owner',
            evidence: ['test', 'draft was wrong (rule)'],
            reviewed: '2026-10-31',
            draft: { label: 'wrong', by: 'rule' },
          }
        }
        const recording = hit.recording
        return {
          ...hit,
          labels,
          ...(recording === undefined
            ? {}
            : {
                recording: {
                  ...recording,
                  items: { ...recording.items, f: item('Filler', 'Nobody', 100) },
                },
              }),
        }
      })
    const pending = buildReport(overturn(false), DEFAULT_EVAL_CONFIG)
    expect(pending.gate.passed).toBe(true)
    expect(pending.review).toMatchObject({
      overturned: 1,
      autoPlayLabels: { labels: 200, checked: 20 },
      pending: 180,
      complete: false,
      minutesLeft: 270,
    })
    expect(pending.autoAllowed).toBe(false)
    expect(renderReport(pending)).toContain('**1 spot checks overturned:**')
    const checked = buildReport(overturn(true), DEFAULT_EVAL_CONFIG)
    expect(checked.review).toMatchObject({ overturned: 1, complete: true })
    expect(checked.autoAllowed).toBe(true)
  })

  it('names the picks held-out cases play without asking', () => {
    expect(autoPicksOf(report.heldOut.outcomes)).toContain(pickKey('sp:pass-000', 'h'))
    expect(autoPicksOf(report.heldOut.outcomes).size).toBe(200)
  })
})

describe('tuneThresholds', () => {
  it('keeps the defaults when calibration finds no wrong Auto play', () => {
    const result = tuneThresholds([
      isrcHit('sp:c1', 'calibration'),
      textOnly('sp:c2', 'calibration', 'exact'),
    ])
    expect(result).toMatchObject({ config: DEFAULT_EVAL_CONFIG, tried: 1, safe: 1 })
    expect(result.calibration).toMatchObject({ cases: 2, auto: 2, wrongAuto: 0 })
  })

  it('turns on the measured fallback when text alone auto-plays a wrong recording', () => {
    const result = tuneThresholds([
      isrcHit('sp:c1', 'calibration'),
      textOnly('sp:c2', 'calibration', 'wrong'),
      textOnly('sp:h', 'held-out', 'exact'),
    ])
    expect(result.config).toEqual({ thresholds: {}, requireReleaseAgreement: true })
    expect(result.tried).toBe(24)
    expect(result.safe).toBe(12)
    expect(result.calibration).toMatchObject({ cases: 2, auto: 1, wrongAuto: 0 })
  })

  it('falls back to the strictest configuration when none is safe', () => {
    const squatter = group({
      id: 'sp:squat',
      split: 'calibration',
      variants: [
        { slice: 'spotify', source: source('Hit', 'Band', 180, { isrc: 'USAAA0000001' }) },
      ],
      items: { h: item('Hit', 'Band', 180, { album: 'LP' }) },
      pages: { 'isrc-songs/1/USAAA0000001': { items: ['h'] } },
      labels: { h: label('wrong') },
    })
    const result = tuneThresholds([squatter])
    expect(result.safe).toBe(0)
    expect(result.config).toEqual({
      thresholds: { auto: 0.9, autoTitle: 0.9, margin: 0.1 },
      requireReleaseAgreement: true,
    })
  })
})
