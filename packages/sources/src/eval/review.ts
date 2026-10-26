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
 * the review checklist. After an overturned spot check, the checklist also lists the certain
 * labels of the held-out Auto plays, which takes a replay of the held-out split with the
 * matching config.
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
  const rows = matchingEval.reviewRows(groups, () => matchingEval.heldOutAutoPicks(groups))
  await store.writeText(REVIEW_FILE, matchingEval.renderReviewCsv(rows))
  return {
    changed,
    rows: rows.length,
    ambiguous: rows.filter((row) => row.kind === 'ambiguous').length,
  }
}

/** What {@link applyReview} did. */
export interface ReviewSummary {
  /** Labels the owner decided or confirmed. */
  applied: number
  /** Rows without a decision. */
  open: number
  /** Rows whose decision could not be applied, with why. */
  rejected: string[]
}

const DECISIONS: ReadonlySet<string> = new Set(['exact', 'equivalent', 'wrong', 'ok'])

/**
 * Writes the owner's decisions from the checklist into the groups. A decision is `exact`,
 * `equivalent` or `wrong` (the label), or `ok`, which confirms the draft the row shows (its
 * `draft` and `by`): a row whose draft is no longer the group's label is refused, since the
 * owner never saw the label it would confirm. The label then counts as the owner's (`by:
 * 'owner'`, `reviewed: <today>`, and the draft it replaced or confirmed in `draft`), and the
 * notes join its evidence. Rows without a decision stay open.
 *
 * @param today The review's date, `YYYY-MM-DD`.
 */
export async function applyReview(
  store: EvalStore,
  csv: string,
  today: string,
): Promise<ReviewSummary> {
  const [header, ...rows] = matchingEval.parseCsv(csv)
  const column = (name: string) => header?.indexOf(name) ?? -1
  const at = {
    group: column('group'),
    video: column('video'),
    decision: column('decision'),
    notes: column('notes'),
    draft: column('draft'),
    by: column('by'),
  }
  const summary: ReviewSummary = { applied: 0, open: 0, rejected: [] }
  if (at.group < 0 || at.video < 0 || at.decision < 0) {
    summary.rejected.push('the header lacks group, video or decision')
    return summary
  }
  const cell = (fields: readonly string[], index: number) =>
    index < 0 ? '' : matchingEval.reviewCell((fields[index] ?? '').trim())
  const groups = new Map<string, EvalGroup>()
  for (const fields of rows) {
    const groupId = cell(fields, at.group)
    const videoId = cell(fields, at.video)
    const decision = cell(fields, at.decision).toLowerCase()
    const notes = cell(fields, at.notes)
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
    const shown = { label: cell(fields, at.draft), by: cell(fields, at.by) }
    const stale = shown.label !== entry.label || shown.by !== entry.by
    if (decision === 'ok' && stale) {
      summary.rejected.push(
        shown.label === ''
          ? `${groupId} ${videoId}: "ok" confirms the draft the row shows, and the row shows none`
          : `${groupId} ${videoId}: "ok" confirms ${shown.label} (${shown.by}), but the label is now ${entry.label} (${entry.by}); run the label command and review the new row`,
      )
      continue
    }
    const label: EvalLabel = decision === 'ok' ? entry.label : (decision as EvalLabel)
    const draft = entry.by === 'owner' ? entry.draft : { label: entry.label, by: entry.by }
    const evidence = [...entry.evidence]
    if (draft !== undefined && entry.by !== 'owner') {
      evidence.push(
        label === draft.label
          ? `owner confirmed the draft (${draft.label}, ${draft.by})`
          : `draft was ${draft.label} (${draft.by})`,
      )
    }
    if (stale && shown.label !== '') {
      evidence.push(`the checklist showed ${shown.label} (${shown.by})`)
    }
    if (notes !== '') evidence.push(`owner: ${notes}`)
    group.labels = {
      ...group.labels,
      [videoId]: {
        label,
        by: 'owner',
        evidence,
        ...(entry.ambiguous === true ? { ambiguous: true } : {}),
        reviewed: today,
        ...(draft === undefined ? {} : { draft }),
      },
    }
    summary.applied += 1
  }
  for (const group of groups.values()) await store.writeGroup(group)
  return summary
}
