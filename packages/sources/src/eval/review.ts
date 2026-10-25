/**
 * Labels and the owner's review, on disk: drafts the labels of every recorded group with the
 * rules of `matchingEval.draftLabels`, writes the review checklist (`REVIEW.csv` in the
 * evaluation folder), and writes the owner's decisions from that file back into the groups.
 *
 * @module
 */

import { matchingEval } from '@fxm/core'
import type { EvalStore } from './store'

type EvalGroup = matchingEval.EvalGroup
type EvalLabel = matchingEval.EvalLabel

/** The review checklist's file name, in the evaluation folder. */
export const REVIEW_FILE = 'REVIEW.csv'

/** Reads every group of the store. */
export async function readGroups(store: EvalStore): Promise<EvalGroup[]> {
  const groups: EvalGroup[] = []
  for (const id of await store.listGroups()) {
    const group = await store.readGroup(id)
    if (group !== undefined) groups.push(group)
  }
  return groups
}

/** What {@link labelGroups} did. */
export interface LabelSummary {
  /** Groups whose labels changed. */
  changed: string[]
  /** Rows written to the checklist. */
  rows: number
  /** Of those, the ambiguous labels to decide. */
  ambiguous: number
}

/**
 * Drafts the labels of every recorded group (keeping the agent's and the owner's) and writes
 * the review checklist.
 */
export async function labelGroups(store: EvalStore): Promise<LabelSummary> {
  const groups = await readGroups(store)
  const changed: string[] = []
  for (const group of groups) {
    if (group.recording === undefined) continue
    const labels = matchingEval.draftLabels(group)
    if (JSON.stringify(labels) !== JSON.stringify(group.labels ?? {})) {
      group.labels = labels
      await store.writeGroup(group)
      changed.push(group.id)
    }
  }
  const rows = matchingEval.reviewRows(groups)
  await store.writeText(REVIEW_FILE, matchingEval.renderReviewCsv(rows))
  return {
    changed,
    rows: rows.length,
    ambiguous: rows.filter((row) => row.kind === 'ambiguous').length,
  }
}

/** Reads CSV text (RFC 4180: quoted fields, doubled quotes, CRLF or LF) into rows of fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((fields) => fields.some((value) => value.trim() !== ''))
}

/** What {@link applyReview} did. */
export interface ReviewSummary {
  /** Labels the owner decided or confirmed. */
  applied: number
  /** Rows without a decision. */
  open: number
  /** Rows whose decision could not be read, with why. */
  rejected: string[]
}

const DECISIONS: ReadonlySet<string> = new Set(['exact', 'equivalent', 'wrong', 'ok'])

/**
 * Writes the owner's decisions from the checklist into the groups. A decision is `exact`,
 * `equivalent` or `wrong` (the label), or `ok` (keeps the drafted label, e.g. for a spot check);
 * the label then counts as the owner's (`by: 'owner'`, `reviewed: <today>`), and the notes join
 * its evidence. Rows without a decision stay open.
 *
 * @param today The review's date, `YYYY-MM-DD`.
 */
export async function applyReview(
  store: EvalStore,
  csv: string,
  today: string,
): Promise<ReviewSummary> {
  const [header, ...rows] = parseCsv(csv)
  const column = (name: string) => header?.indexOf(name) ?? -1
  const at = {
    group: column('group'),
    video: column('video'),
    decision: column('decision'),
    notes: column('notes'),
  }
  const summary: ReviewSummary = { applied: 0, open: 0, rejected: [] }
  if (at.group < 0 || at.video < 0 || at.decision < 0) {
    summary.rejected.push('the header lacks group, video or decision')
    return summary
  }
  const groups = new Map<string, EvalGroup>()
  for (const fields of rows) {
    const groupId = fields[at.group]?.trim() ?? ''
    const videoId = fields[at.video]?.trim() ?? ''
    const decision = (fields[at.decision] ?? '').trim().toLowerCase()
    const notes = at.notes < 0 ? '' : (fields[at.notes] ?? '').trim()
    if (decision === '') {
      summary.open += 1
      continue
    }
    if (!DECISIONS.has(decision)) {
      summary.rejected.push(
        `${groupId} ${videoId}: "${decision}" is not exact, equivalent, wrong or ok`,
      )
      continue
    }
    let group = groups.get(groupId)
    if (group === undefined) {
      group = await store.readGroup(groupId)
      if (group === undefined) {
        summary.rejected.push(`${groupId}: no such group`)
        continue
      }
      groups.set(groupId, group)
    }
    const entry = group.labels?.[videoId]
    if (entry === undefined) {
      summary.rejected.push(`${groupId} ${videoId}: no such label`)
      continue
    }
    const label: EvalLabel = decision === 'ok' ? entry.label : (decision as EvalLabel)
    const evidence = [...entry.evidence]
    if (entry.label !== label) evidence.push(`draft was ${entry.label} (${entry.by})`)
    if (notes !== '') evidence.push(`owner: ${notes}`)
    group.labels = {
      ...group.labels,
      [videoId]: {
        label,
        by: 'owner',
        evidence,
        ...(entry.ambiguous === true ? { ambiguous: true } : {}),
        reviewed: today,
      },
    }
    summary.applied += 1
  }
  for (const group of groups.values()) await store.writeGroup(group)
  return summary
}
