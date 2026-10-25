import { describe, expect, it } from 'vitest'
import type { MatchSource } from '../types'
import {
  draftLabel,
  draftLabels,
  labelTargets,
  REVIEW_COLUMNS,
  renderReviewCsv,
  reviewPlan,
  trustedIsrcs,
} from './labels'
import { group, item, label, source } from './testing'
import type { EvalItem, EvalPage } from './types'

const INPUT = source('Song Title', 'The Artist', 200, {
  album: { name: 'The Album' },
  isrc: 'USAAA2000001',
  label: 'Big Label Records',
  releaseDate: '2020-05-01',
})

/** A group whose primary input is `input`, with one candidate `x` and optional pages. */
function withCandidate(
  candidate: EvalItem,
  pages: Record<string, EvalPage> = {},
  input: MatchSource = INPUT,
) {
  return group({
    variants: [{ slice: 'spotify', source: input }],
    items: { x: candidate, filler: item('Filler', 'Nobody', 150) },
    pages,
  })
}

describe('draftLabel: certain wrong', () => {
  it.each([
    ['a version tag on one side', item('Song Title (Live)', 'The Artist', 201), /version: \+live/u],
    ['more than 10 s apart', item('Song Title', 'The Artist', 215), /more than 10 s/u],
    ['another title', item('Completely Different', 'The Artist', 200), /another title/u],
    ['no shared artist', item('Song Title', 'Someone Else', 200), /no shared artist/u],
    [
      'a featured artist the input does not credit',
      item('Song Title (feat. Guest)', 'The Artist', 200),
      /features guest/iu,
    ],
  ])('for %s', (_case, candidate, evidence) => {
    const draft = draftLabel(withCandidate(candidate), 'x')
    expect(draft).toMatchObject({ label: 'wrong', by: 'rule' })
    expect(draft?.ambiguous).toBeUndefined()
    expect(draft?.evidence.join('; ')).toMatch(evidence)
  })

  it('for explicit against clean, unless the ISRC search found it', () => {
    const explicit = { ...INPUT, explicit: true }
    const hit = draftLabel(
      withCandidate(
        item('Song Title', 'The Artist', 200),
        { 'isrc-songs/1/USAAA2000001': { items: ['x'] } },
        explicit,
      ),
      'x',
    )
    expect(hit).toMatchObject({ label: 'exact', ambiguous: true })
    expect(hit?.evidence.join('; ')).toMatch(/explicit mark differs/u)
  })

  it('for explicit against clean', () => {
    const draft = draftLabel(
      withCandidate(item('Song Title', 'The Artist', 200), {}, { ...INPUT, explicit: true }),
      'x',
    )
    expect(draft).toMatchObject({ label: 'wrong' })
    expect(draft?.evidence.join('; ')).toMatch(/explicit against clean/u)
  })
})

describe('draftLabel: certain exact', () => {
  it('when the ISRC search found it with the same title, artist and length', () => {
    const draft = draftLabel(
      withCandidate(item('Song Title', 'The Artist', 201), {
        'isrc-songs/1/USAAA2000001': { items: ['filler', 'x'] },
      }),
      'x',
    )
    expect(draft).toEqual({
      label: 'exact',
      by: 'rule',
      evidence: ['length +1 s', 'found by the ISRC search for USAAA2000001 (#2, attempt 1)'],
    })
  })

  it('when a MusicBrainz ISRC of the recording found it, or the top-result card', () => {
    const viaMusicBrainz = withCandidate(item('Song Title', 'The Artist', 200), {
      'isrc-songs/1/GBBBB1900002': { items: ['x'] },
    })
    viaMusicBrainz.musicBrainz = {
      exact: {
        recording: 'mbid',
        title: 'Song Title',
        artists: ['The Artist'],
        isrcs: ['GBBBB1900002'],
      },
    }
    expect(trustedIsrcs(viaMusicBrainz)).toEqual(new Set(['USAAA2000001', 'GBBBB1900002']))
    expect(draftLabel(viaMusicBrainz, 'x')?.label).toBe('exact')
    const card = draftLabel(
      withCandidate(item('Song Title', 'The Artist', 200), {
        'isrc-top-card/USAAA2000001': { item: 'x' },
      }),
      'x',
    )
    expect(card?.evidence).toContain('found by the top-result card for USAAA2000001')
  })

  it('when it is first on the ISRC search in another script', () => {
    const idol = source('Idol', 'YOASOBI', 213, { isrc: 'JPU902300341' })
    const draft = draftLabel(
      withCandidate(
        item('アイドル', 'YOASOBI', 213),
        { 'isrc-songs/1/JPU902300341': { items: ['x'] } },
        idol,
      ),
      'x',
    )
    expect(draft).toMatchObject({ label: 'exact', by: 'rule' })
  })

  it("when its description's label or year agrees, at the same length", () => {
    const draft = draftLabel(
      withCandidate(item('Song Title', 'The Artist', 200, { album: 'Single' }), {
        'description/x': {
          facts: { providedBy: 'Distributor', label: 'Big Label Records', releaseYear: 2019 },
        },
      }),
      'x',
    )
    expect(draft?.label).toBe('exact')
    expect(draft?.evidence.at(-1)).toMatch(/label agrees/u)
  })

  it("when it is on the input's own album, unless that is a compilation or self-titled", () => {
    expect(
      draftLabel(withCandidate(item('Song Title', 'The Artist', 200, { album: 'The Album' })), 'x'),
    ).toMatchObject({ label: 'exact', by: 'rule' })
    const hits = { ...INPUT, album: { name: 'Greatest Hits' } }
    expect(
      draftLabel(
        withCandidate(item('Song Title', 'The Artist', 200, { album: 'Greatest Hits' }), {}, hits),
        'x',
      )?.ambiguous,
    ).toBe(true)
    const selfTitled = { ...INPUT, album: { name: 'The Artist' } }
    expect(
      draftLabel(
        withCandidate(
          item('Song Title', 'The Artist', 200, { album: 'The Artist' }),
          {},
          selfTitled,
        ),
        'x',
      )?.ambiguous,
    ).toBe(true)
  })
})

describe('draftLabel: ambiguous drafts', () => {
  it('drafts exact for the same title, artist and length without evidence', () => {
    const draft = draftLabel(
      withCandidate(item('Song Title', 'The Artist', 199, { album: 'Other' })),
      'x',
    )
    expect(draft).toMatchObject({ label: 'exact', ambiguous: true })
    expect(draft?.evidence.join('; ')).toMatch(/without ISRC, label, year or album evidence/u)
  })

  it('drafts wrong for another label two or more years earlier', () => {
    const draft = draftLabel(
      withCandidate(item('Song Title', 'The Artist', 200, { album: 'Other' }), {
        'description/x': { facts: { label: 'Old Label', releaseYear: 1995 } },
      }),
      'x',
    )
    expect(draft).toMatchObject({ label: 'wrong', ambiguous: true })
  })

  it('drafts wrong for 3 to 10 s apart, or an ISRC hit that far apart', () => {
    expect(draftLabel(withCandidate(item('Song Title', 'The Artist', 206)), 'x')).toMatchObject({
      label: 'wrong',
      ambiguous: true,
    })
    const far = draftLabel(
      withCandidate(item('Song Title', 'The Artist', 206), {
        'isrc-songs/1/USAAA2000001': { items: ['x'] },
      }),
      'x',
    )
    expect(far?.ambiguous).toBe(true)
  })

  it('drafts nothing for an unknown item', () => {
    expect(draftLabel(withCandidate(item('Song Title', 'The Artist', 200)), 'nope')).toBeUndefined()
  })
})

describe('draftLabels and labelTargets', () => {
  const recorded = group({
    variants: [
      { slice: 'spotify', source: INPUT },
      { slice: 'data-export', source: source('Song Title', 'The Artist', undefined) },
    ],
    items: {
      hit: item('Song Title', 'The Artist', 200, { album: 'The Album' }),
      filler: item('Filler', 'Nobody', 150),
      other: item('Song Title', 'The Artist', 200, { album: 'Other' }),
    },
    pages: {
      'isrc-songs/1/USAAA2000001': { items: ['filler', 'hit'] },
      'songs/The Artist Song Title': { items: ['hit', 'other'] },
    },
    labels: {
      hit: { label: 'wrong', by: 'owner', evidence: ['heard it'], reviewed: '2026-10-30' },
      gone: label('exact'),
    },
  })

  it("targets every input's pick and the ISRC search's first item", () => {
    expect(labelTargets(recorded)).toEqual(['filler', 'hit'])
  })

  it("drafts the rules' labels and keeps the owner's and the old ones", () => {
    const labels = draftLabels(recorded)
    expect(labels.hit).toEqual(recorded.labels?.hit)
    expect(labels.gone).toEqual(label('exact'))
    expect(labels.filler).toMatchObject({ label: 'wrong', by: 'rule' })
    expect(Object.keys(labels)).toEqual(['filler', 'gone', 'hit'])
  })
})

describe('the review', () => {
  const groups = [
    group({
      id: 'sp:one',
      variants: [{ slice: 'spotify', source: INPUT }],
      items: Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `v${index}`,
          item(`Song ${index}`, 'The Artist', 200),
        ]),
      ),
      labels: {
        ...Object.fromEntries(
          Array.from({ length: 10 }, (_, index) => [`v${index}`, label('exact')]),
        ),
        v10: label('exact', { ambiguous: true, by: 'agent' }),
        v11: label('wrong', { ambiguous: true, by: 'owner', reviewed: '2026-10-30' }),
      },
    }),
  ]

  it('lists the undecided ambiguous labels, then a 10 % spot check of the others', () => {
    const plan = reviewPlan(groups)
    expect(plan.ambiguous).toEqual({ total: 2, decided: 1 })
    expect(plan.spotCheck).toEqual({ labels: 10, required: 1, checked: 0 })
    expect(plan.pending.map((row) => row.kind)).toEqual(['ambiguous', 'spot-check'])
    expect(plan.pending[0]).toMatchObject({
      group: 'sp:one',
      video: 'v10',
      link: 'https://music.youtube.com/watch?v=v10',
      draft: 'exact',
      by: 'agent',
      decision: '',
    })
    expect(reviewPlan(groups).pending).toEqual(plan.pending)
  })

  it('stops asking for spot checks once enough are done', () => {
    const checked = JSON.parse(JSON.stringify(groups)) as typeof groups
    const labels = checked[0]?.labels
    if (labels?.v3 !== undefined) labels.v3.reviewed = '2026-10-30'
    expect(reviewPlan(checked).pending.map((row) => row.kind)).toEqual(['ambiguous'])
  })

  it('writes RFC 4180 CSV', () => {
    const csv = renderReviewCsv([
      {
        ...Object.fromEntries(REVIEW_COLUMNS.map((column) => [column, ''])),
        input: 'A, "B"\nC',
        kind: 'ambiguous',
      } as never,
    ])
    expect(csv).toBe(`${REVIEW_COLUMNS.join(',')}\r\nambiguous,,,,"A, ""B""\nC",,,,,,,\r\n`)
  })
})
