import { matchingEval } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { applyReview, labelGroups, REVIEW_FILE } from './review'
import { memoryStore } from './store'

type EvalGroup = matchingEval.EvalGroup

const { parseCsv } = matchingEval

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
        '-dashed0001': {
          kind: 'song',
          title: '=Creep',
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
      '-dashed0001': { label: 'wrong', by: 'agent', evidence: ['a cover'], ambiguous: true },
    },
  }
}

/** The checklist as the owner edits it: `decide(row)` gives the row's decision and notes. */
function decided(
  csv: string,
  decide: (row: Record<string, string>) => [string, string] | undefined,
): string {
  const [header = [], ...rows] = parseCsv(csv)
  const edited = rows.map((fields) => {
    const row = Object.fromEntries(
      header.map((name, index) => [name, matchingEval.reviewCell(fields[index] ?? '')]),
    )
    const decision = decide(row)
    if (decision === undefined) return fields
    const copy = [...fields]
    copy[header.indexOf('decision')] = decision[0]
    copy[header.indexOf('notes')] = decision[1]
    return copy
  })
  return [header, ...edited]
    .map((fields) => fields.map((field) => `"${field.replace(/"/gu, '""')}"`).join(','))
    .join('\n')
}

describe('labelGroups', () => {
  it("drafts the rules' labels, keeps the agent's, and writes the checklist", async () => {
    const store = memoryStore([recorded()])
    const summary = await labelGroups(store)
    expect(summary).toEqual({ changed: ['sp:creep'], rows: 3, ambiguous: 2 })
    const group = await store.readGroup('sp:creep')
    expect(group?.labels?.hit).toMatchObject({ label: 'exact', by: 'rule' })
    expect(group?.labels?.other).toMatchObject({ by: 'agent', ambiguous: true })
    const csv = store.texts.get(REVIEW_FILE) ?? ''
    expect(csv.split('\r\n')[0]).toBe(matchingEval.REVIEW_COLUMNS.join(','))
    expect(csv).toContain('ambiguous,sp:creep,other,')
    expect(csv).toContain("ambiguous,sp:creep,'-dashed0001,")
    expect(csv).toContain('spot-check,sp:creep,hit,')
    expect(await labelGroups(store)).toMatchObject({ changed: [] })
  })
})

describe('applyReview', () => {
  it("writes the owner's decisions into the groups and keeps the open rows open", async () => {
    const store = memoryStore([recorded()])
    await labelGroups(store)
    const csv = decided(store.texts.get(REVIEW_FILE) ?? '', (row) =>
      row.video === 'other' ? ['wrong', 'the compilation has a different master'] : undefined,
    )
    const extra = [
      '"spot-check","sp:creep","nope","","","","","exact","rule","","exact",""',
      '"spot-check","sp:creep","hit","","","","","exact","rule","","maybe",""',
    ]
    const summary = await applyReview(store, [csv, ...extra].join('\n'), '2026-10-30')
    expect(summary.applied).toBe(1)
    expect(summary.open).toBe(2)
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
      draft: { label: 'exact', by: 'agent' },
    })
  })

  it("confirms the draft the row shows with 'ok', and reads protected cells back", async () => {
    const store = memoryStore([recorded()])
    await labelGroups(store)
    const csv = decided(store.texts.get(REVIEW_FILE) ?? '', (row) =>
      row.video === 'other' ? undefined : ['ok', ''],
    )
    expect(await applyReview(store, csv, '2026-10-30')).toMatchObject({ applied: 2, rejected: [] })
    const group = await store.readGroup('sp:creep')
    expect(group?.labels?.hit).toMatchObject({
      label: 'exact',
      by: 'owner',
      reviewed: '2026-10-30',
      draft: { label: 'exact', by: 'rule' },
    })
    expect(group?.labels?.hit?.evidence.at(-1)).toBe('owner confirmed the draft (exact, rule)')
    expect(group?.labels?.['-dashed0001']).toMatchObject({ label: 'wrong', by: 'owner' })
  })

  it("refuses 'ok' for a draft that changed since the checklist was written", async () => {
    const store = memoryStore([recorded()])
    await labelGroups(store)
    const csv = decided(store.texts.get(REVIEW_FILE) ?? '', (row) =>
      row.video === 'other' ? ['ok', ''] : undefined,
    )
    // An agent drafts the label again before the owner's decisions are applied.
    const group = await store.readGroup('sp:creep')
    if (group?.labels?.other === undefined) throw new Error('no label')
    group.labels.other = { ...group.labels.other, label: 'wrong' }
    await store.writeGroup(group)
    const summary = await applyReview(store, csv, '2026-10-30')
    expect(summary.applied).toBe(0)
    expect(summary.rejected).toEqual([
      'sp:creep other: "ok" confirms exact (agent), but the label is now wrong (agent); run the label command and review the new row',
    ])
    expect((await store.readGroup('sp:creep'))?.labels?.other).toMatchObject({ by: 'agent' })
    // A decision of its own still applies, and says what the checklist showed.
    const explicit = decided(store.texts.get(REVIEW_FILE) ?? '', (row) =>
      row.video === 'other' ? ['equivalent', ''] : undefined,
    )
    expect(await applyReview(store, explicit, '2026-10-30')).toMatchObject({ applied: 1 })
    const applied = (await store.readGroup('sp:creep'))?.labels?.other
    expect(applied).toMatchObject({
      label: 'equivalent',
      by: 'owner',
      draft: { label: 'wrong', by: 'agent' },
    })
    expect(applied?.evidence).toContain('the checklist showed exact (agent)')
  })

  it("refuses 'ok' without the row's draft, and a file without the columns", async () => {
    const store = memoryStore([recorded()])
    await labelGroups(store)
    const csv = 'group,video,decision\nsp:creep,hit,ok\n'
    expect(await applyReview(store, csv, '2026-10-30')).toMatchObject({
      applied: 0,
      rejected: ['sp:creep hit: "ok" confirms the draft the row shows, and the row shows none'],
    })
    expect((await applyReview(store, 'a,b\n1,2', '2026-10-30')).rejected).toEqual([
      'the header lacks group, video or decision',
    ])
  })
})
