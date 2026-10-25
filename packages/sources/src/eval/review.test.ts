import { matchingEval } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { applyReview, labelGroups, parseCsv, REVIEW_FILE } from './review'
import { memoryStore } from './store'

type EvalGroup = matchingEval.EvalGroup

function recorded(): EvalGroup {
  return {
    id: 'sp:creep',
    split: 'held-out',
    categories: ['mainstream'],
    provenance: ['test'],
    variants: [
      {
        slice: 'spotify',
        source: {
          title: 'Creep',
          artists: [{ name: 'Radiohead' }],
          album: { name: 'Pablo Honey' },
          durationMs: 238_000,
          isrc: 'GBAYE9200070',
        },
      },
    ],
    recording: {
      recordedAt: ['2026-10-26'],
      items: {
        hit: {
          kind: 'song',
          title: 'Creep',
          artists: ['Radiohead'],
          album: 'Pablo Honey',
          durationMs: 239_000,
        },
        other: {
          kind: 'song',
          title: 'Creep',
          artists: ['Radiohead'],
          album: 'Best Of',
          durationMs: 238_000,
        },
      },
      pages: {
        'isrc-songs/1/GBAYE9200070': { items: ['hit'] },
      },
    },
    labels: {
      other: { label: 'exact', by: 'agent', evidence: ['looks the same'], ambiguous: true },
    },
  }
}

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes, line breaks in quotes and both line ends', () => {
    expect(parseCsv('a,"b, ""c""",d\r\n"e\nf",,g\nlast')).toEqual([
      ['a', 'b, "c"', 'd'],
      ['e\nf', '', 'g'],
      ['last'],
    ])
    expect(parseCsv('\n\n')).toEqual([])
  })
})

describe('labelGroups', () => {
  it("drafts the rules' labels, keeps the agent's, and writes the checklist", async () => {
    const store = memoryStore([recorded()])
    const summary = await labelGroups(store)
    expect(summary).toEqual({ changed: ['sp:creep'], rows: 2, ambiguous: 1 })
    const group = await store.readGroup('sp:creep')
    expect(group?.labels?.hit).toMatchObject({ label: 'exact', by: 'rule' })
    expect(group?.labels?.other).toMatchObject({ by: 'agent', ambiguous: true })
    const csv = store.texts.get(REVIEW_FILE) ?? ''
    expect(csv.split('\r\n')[0]).toBe(matchingEval.REVIEW_COLUMNS.join(','))
    expect(csv).toContain('ambiguous,sp:creep,other,')
    expect(csv).toContain('spot-check,sp:creep,hit,')
    expect(await labelGroups(store)).toMatchObject({ changed: [] })
  })
})

describe('applyReview', () => {
  it("writes the owner's decisions into the groups and keeps the open rows open", async () => {
    const store = memoryStore([recorded()])
    await labelGroups(store)
    const rows = parseCsv(store.texts.get(REVIEW_FILE) ?? '')
    const header = rows[0] ?? []
    const decision = header.indexOf('decision')
    const notes = header.indexOf('notes')
    const edited = rows.map((fields, index) => {
      const copy = [...fields]
      if (index > 0 && copy[2] === 'other') {
        copy[decision] = 'wrong'
        copy[notes] = 'the compilation has a different master'
      }
      return copy
    })
    edited.push(['spot-check', 'sp:creep', 'nope', '', '', '', '', '', '', '', 'exact', ''])
    edited.push(['spot-check', 'sp:creep', 'hit', '', '', '', '', '', '', '', 'maybe', ''])
    const csv = edited
      .map((fields) => fields.map((field) => `"${field.replace(/"/gu, '""')}"`).join(','))
      .join('\n')
    const summary = await applyReview(store, csv, '2026-10-30')
    expect(summary.applied).toBe(1)
    expect(summary.open).toBe(1)
    expect(summary.rejected).toEqual([
      'sp:creep nope: no such label',
      'sp:creep hit: "maybe" is not exact, equivalent, wrong or ok',
    ])
    const group = await store.readGroup('sp:creep')
    expect(group?.labels?.other).toEqual({
      label: 'wrong',
      by: 'owner',
      evidence: [
        'looks the same',
        'draft was exact (agent)',
        'owner: the compilation has a different master',
      ],
      ambiguous: true,
      reviewed: '2026-10-30',
    })
  })

  it("confirms a drafted label with 'ok', and refuses a file without the columns", async () => {
    const store = memoryStore([recorded()])
    await labelGroups(store)
    const csv = 'group,video,decision\nsp:creep,hit,ok\n'
    expect(await applyReview(store, csv, '2026-10-30')).toMatchObject({ applied: 1 })
    expect((await store.readGroup('sp:creep'))?.labels?.hit).toMatchObject({
      label: 'exact',
      by: 'owner',
      reviewed: '2026-10-30',
    })
    expect((await applyReview(store, 'a,b\n1,2', '2026-10-30')).rejected).toEqual([
      'the header lacks group, video or decision',
    ])
  })
})
