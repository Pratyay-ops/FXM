import { describe, expect, it } from 'vitest'
import { DEFAULT_EVAL_CONFIG, evaluateCase, optionsOf } from './evaluate'
import { buildReport, EVAL_GATE, renderReport } from './report'
import { group, item, label, source } from './testing'
import { tuneThresholds } from './tune'
import { casesOf, type EvalGroup, type EvalSplit } from './types'

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
    expect(outcome.uncapped).toEqual({ band: 'auto', pick: 'm', label: 'exact' })
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

  it('measures the ISRC-miss cap and the MusicBrainz exact path', () => {
    const singles = report.heldOut.isrcCap.find((row) => row.name === 'spotify-singles')
    expect(singles).toMatchObject({ cases: 1, trusted: 1, misses: 1, auto: 0, autoUncapped: 1 })
    expect(singles?.wrongPrevented).toBe(0)
    const all = report.heldOut.coverage.find((row) => row.name === 'all')
    expect(all).toMatchObject({ tracks: 2, linked: 1, oneIsrc: 1, agrees: 1 })
  })

  it('bounds the wrong-Auto rate when none is wrong', () => {
    const clean = buildReport([isrcHit('sp:a', 'held-out'), isrcHit('sp:b', 'held-out')])
    expect(clean.gate.wrongAuto).toBe(0)
    expect(clean.gate.upperBound).toBeCloseTo(1 - 0.05 ** (1 / 2), 10)
    expect(clean.gate.failures).toContain(
      `2 held-out groups, fewer than ${EVAL_GATE.minHeldOutGroups}`,
    )
  })

  it('renders the same Markdown every time, saying Auto stays off', () => {
    const text = renderReport(report)
    expect(renderReport(buildReport(groups, DEFAULT_EVAL_CONFIG))).toBe(text)
    expect(text).toContain('**Auto setting: OFF.**')
    expect(text).toContain('- sp:wrong/spotify: x (wrong)')
    expect(text).toContain('The set is not complete yet')
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
