/**
 * What the UI says about roots: the line under a folder's name, which folders need the user,
 * whose songs can't play right now, and what a finished scan found.
 *
 * @module
 */

import { countLabel, playedLabel } from '../library/format'
import { CHECKING, type RootStatus } from './local-files'
import type { ScanOutcome } from './scanner'
import type { LocalRootRecord, SkippedCounts } from './types'

/** "3 files can't be played here", or nothing when no file was left out. */
export function skippedText(skipped: SkippedCounts | undefined): string | undefined {
  const count = (skipped?.unsupported ?? 0) + (skipped?.unreadable ?? 0)
  if (count === 0) return undefined
  return `${countLabel(count, 'file')} can’t be played here`
}

/** Whether a root is being scanned or waits for its scan. */
export function isScanning(status: RootStatus): boolean {
  return status.state === 'scanning' || status.state === 'queued'
}

/** Whether a root needs the user to do something before its songs play, or failed. */
export function needsAttention(status: RootStatus): boolean {
  return (
    status.state === 'needs-access' ||
    status.state === 'denied' ||
    status.state === 'unavailable' ||
    status.state === 'missing' ||
    status.state === 'failed'
  )
}

/** How far a scan got, for people: "Reading files: 12 of 340". */
export function scanText(status: RootStatus): string {
  if (status.state === 'queued') return 'Waiting to scan…'
  if (status.state !== 'scanning') return ''
  // Until the walk is over, the total isn't known: a bar would fill up and start over.
  if (!status.walked) {
    return status.read === 0 ? 'Looking for music…' : `Read ${countLabel(status.read, 'file')}…`
  }
  return `Reading files: ${status.read.toLocaleString('en')} of ${status.found.toLocaleString('en')}`
}

/** The line under a root's name: its songs, or what it needs. */
export function statusText(root: LocalRootRecord, status: RootStatus, songs: number): string {
  switch (status.state) {
    case 'queued':
    case 'scanning':
      return scanText(status)
    case 'needs-access':
      return 'FXM needs your permission to read this folder again'
    case 'denied':
      return 'You didn’t allow FXM to read this folder'
    case 'unavailable':
      return root.kind === 'picked-folder'
        ? 'Choose this folder again to play its songs'
        : 'Choose these files again to play them'
    case 'missing':
      return 'This folder was moved or deleted'
    case 'failed':
      return status.message
    default: {
      const parts = [countLabel(songs, 'song')]
      if (root.kind !== 'folder') parts.push('until FXM reloads')
      else if (root.scannedAt !== undefined) parts.push(`updated ${playedLabel(root.scannedAt)}`)
      const skipped = skippedText(root.skipped)
      if (skipped !== undefined) parts.push(skipped)
      return parts.join(' · ')
    }
  }
}

/**
 * The folders in one line, for phones, where only the folders that need something show in
 * full: "Music · 8 songs · updated just now", "Music and 2 more · 1,204 songs".
 */
export function sourcesSummary(
  roots: readonly LocalRootRecord[],
  statuses: Readonly<Record<string, RootStatus>>,
  songCounts: ReadonlyMap<string, number>,
): string {
  const [first] = roots
  if (first === undefined) return ''
  const statusOf = (root: LocalRootRecord) => statuses[root.id] ?? CHECKING
  if (roots.length === 1) {
    const status = statusOf(first)
    const songs = songCounts.get(first.id) ?? 0
    if (isScanning(status)) return `${first.name} · ${scanText(status)}`
    const parts = [first.name, countLabel(songs, 'song')]
    if (first.kind !== 'folder') parts.push('until FXM reloads')
    else if (first.scannedAt !== undefined) parts.push(`updated ${playedLabel(first.scannedAt)}`)
    return parts.join(' · ')
  }
  const songs = roots.reduce((sum, root) => sum + (songCounts.get(root.id) ?? 0), 0)
  const scanning = roots.some((root) => isScanning(statusOf(root)))
  return `${first.name} and ${roots.length - 1} more · ${scanning ? 'scanning…' : countLabel(songs, 'song')}`
}

/** Why the songs of a root can't play right now. */
export interface BlockedRoot {
  /** The badge on its songs' rows. */
  badge: string
  /** What trying to play one of its songs says. */
  message: string
}

/**
 * The roots whose songs can't play right now, by root ID: chosen files the browser forgot, a
 * folder FXM was refused, a folder that is gone. A folder that only needs asking again isn't
 * one: a click on Play asks.
 */
export function blockedRootsOf(
  roots: readonly LocalRootRecord[],
  statuses: Readonly<Record<string, RootStatus>>,
): Map<string, BlockedRoot> {
  const blocked = new Map<string, BlockedRoot>()
  for (const root of roots) {
    switch (statuses[root.id]?.state) {
      case 'unavailable':
        blocked.set(root.id, {
          badge: 'Choose again',
          message:
            root.kind === 'picked-folder'
              ? `Choose “${root.name}” again to play this song`
              : 'Choose your files again to play this song',
        })
        break
      case 'denied':
        blocked.set(root.id, {
          badge: 'Choose again',
          message: `Choose “${root.name}” again to play this song`,
        })
        break
      case 'missing':
        blocked.set(root.id, {
          badge: 'Missing',
          message: `“${root.name}” was moved or deleted. Find it again to play this song`,
        })
        break
      default:
    }
  }
  return blocked
}

/**
 * What a finished scan found, to announce: "Added “Music”: 8 songs", "No music files were
 * found in “Music”", with the files left out. `verb` says what happened to the root.
 */
export function scanSummary(
  root: LocalRootRecord,
  outcome: Pick<ScanOutcome, 'added' | 'updated' | 'unchanged' | 'moved' | 'skipped'>,
  songs: number,
  verb: 'Added' | 'Found',
): string {
  const skipped = skippedText(outcome.skipped)
  if (root.kind === 'picked-files') {
    // Single files add up: say what this pick brought.
    const listed = outcome.added + outcome.updated + outcome.unchanged + outcome.moved
    const text =
      listed === 0
        ? 'None of those files can be played here'
        : `Added ${countLabel(listed, 'song')}`
    return listed > 0 && skipped !== undefined ? `${text}. ${skipped}` : text
  }
  if (songs === 0) {
    return skipped === undefined
      ? `No music files were found in “${root.name}”`
      : `No songs FXM can play in “${root.name}”: ${skipped}`
  }
  const text = `${verb} “${root.name}”: ${countLabel(songs, 'song')}`
  return skipped === undefined ? text : `${text}. ${skipped}`
}
