/**
 * What sync tells people: problems, failures while setting up, and summaries.
 *
 * @module
 */

import { countLabel } from '../library/format'
import { ConnectError } from './controller'
import { SyncError, type SyncErrorCode } from './engine'
import type { RemovalCounts } from './merge'
import type { SnapshotSummary } from './snapshot'
import type { SyncProblem } from './sync-store'

/** What the user can do about a problem. */
export type ProblemAction =
  /** Paste a new token. */
  | 'token'
  /** Set sync up again: find the account's sync gist, or create one. */
  | 'setup'
  /** Rewrite the gist from this device. */
  | 'rewrite'
  /** Remove what the gist lacks here too, or keep it and put it back. */
  | 'removals'

const time = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' })

/** "3 playlists, 120 liked songs and 900 plays": what a sync would remove, for people. */
export function removalText(removed: RemovalCounts | undefined): string {
  if (removed === undefined) return 'much of your library'
  const parts = [
    removed.playlists > 0 ? countLabel(removed.playlists, 'playlist') : '',
    removed.likes > 0 ? countLabel(removed.likes, 'liked song') : '',
    removed.follows > 0 ? countLabel(removed.follows, 'follow') : '',
    removed.plays > 0 ? countLabel(removed.plays, 'play') : '',
  ].filter((part) => part !== '')
  if (parts.length === 0) return 'much of your library'
  const last = parts.pop() as string
  return parts.length === 0 ? last : `${parts.join(', ')} and ${last}`
}

/** A problem as the Settings page shows it, with what the user can do about it. */
export function problemMessage(problem: SyncProblem): { text: string; action?: ProblemAction } {
  switch (problem.code) {
    case 'unauthorized':
      return {
        text: 'GitHub no longer accepts your token: it may have expired or been revoked. Sync is paused until you paste a new one.',
        action: 'token',
      }
    case 'forbidden':
      return {
        text: 'Your token may not change gists. Paste a token with the Gists permission set to Read and write.',
        action: 'token',
      }
    case 'gone':
      return {
        text: 'Your sync gist is gone from GitHub. Set sync up again to find another one or create a new one.',
        action: 'setup',
      }
    case 'not-owner':
      return {
        text: 'The sync gist belongs to another GitHub account. Set sync up again with your own.',
        action: 'setup',
      }
    case 'not-sync-gist':
      return {
        text: 'The gist FXM syncs with is not an FXM sync gist any more. Set sync up again.',
        action: 'setup',
      }
    case 'public':
      return {
        text: 'Your sync gist is public, so FXM stopped syncing. Delete it on GitHub, then set up sync again: FXM creates a new secret one.',
        action: 'setup',
      }
    case 'too-new':
      return {
        text: 'Your synced library was saved by a newer version of FXM. Update FXM on this device to keep syncing.',
      }
    case 'corrupt':
      return {
        text: 'Your sync gist was changed outside FXM and can’t be read. You can rewrite it from this device: your other devices keep their libraries and add back what this one lacks.',
        action: 'rewrite',
      }
    case 'too-large':
      return {
        text: `Your library is too large to sync: ${problem.detail ?? 'something in it'} doesn’t fit in a gist.`,
      }
    case 'removals':
      return {
        text: `Another device removed ${removalText(problem.removed)} from your synced library. Remove them here too, or keep them? Keeping them puts them back on your other devices. Sync waits until you choose.`,
        action: 'removals',
      }
    case 'rate-limited':
      return {
        text:
          problem.retryAt === undefined
            ? 'GitHub asked FXM to slow down. Sync tries again later.'
            : `GitHub asked FXM to slow down. Sync tries again after ${time.format(problem.retryAt)}.`,
      }
    case 'network':
      return { text: 'GitHub can’t be reached. Sync tries again when you’re back online.' }
    case 'busy':
      return { text: 'Your gist kept changing while this device synced. Sync tries again shortly.' }
    default:
      return { text: 'Sync failed. FXM tries again in a few minutes.' }
  }
}

/** What a toast says when automatic sync stopped for something only the user can fix. */
export function stoppedMessage(error: {
  code: SyncErrorCode
  removed?: RemovalCounts | undefined
}): string {
  switch (error.code) {
    case 'removals':
      return `Another device removed ${removalText(error.removed)}. Sync waits for you to choose.`
    case 'public':
      return 'Your sync gist is public, so sync stopped.'
    default:
      return 'Sync stopped until you check it.'
  }
}

const SETUP_ERRORS: Partial<Record<SyncErrorCode, string>> = {
  unauthorized:
    'GitHub didn’t accept that token. Check that you copied all of it and that it hasn’t expired.',
  forbidden:
    'This token may not create or change gists. Give it the Gists permission, set to Read and write.',
  gone: 'There’s no such gist, or your token can’t see it.',
  'not-owner': 'That gist belongs to another GitHub account.',
  'not-sync-gist': 'That gist isn’t an FXM sync gist.',
  public:
    'That gist is public, and FXM syncs only with a secret one. Delete it on GitHub, then set up sync without its link: FXM creates a new secret gist.',
  'too-new': 'That gist was saved by a newer version of FXM. Update FXM first.',
  corrupt: 'That gist was changed outside FXM and can’t be read.',
  network: 'GitHub can’t be reached. Check your connection and try again.',
  busy: 'Another tab is syncing. Try again in a moment.',
}

/** Why setting sync up failed, for the dialog. */
export function setupErrorText(error: unknown): string {
  if (error instanceof ConnectError) {
    switch (error.code) {
      case 'token-format':
        return 'That doesn’t look like a GitHub token. Copy the whole token GitHub shows you.'
      case 'token-too-broad':
        return `This token can do more than FXM needs (${error.detail}). Create a fine-grained token with only the Gists permission instead.`
      case 'gist-link':
        return 'That isn’t a link to a gist. Copy it from Settings › Sync on your other device.'
      case 'other-account':
        return `This token belongs to @${error.detail}, not to the account of your sync gist. Use a token of that account, or turn sync off to switch accounts.`
    }
  }
  if (error instanceof SyncError) {
    if (error.code === 'too-large' || error.code === 'rate-limited') {
      return problemMessage({
        code: error.code,
        at: 0,
        ...(error.detail ? { detail: error.detail } : {}),
      }).text
    }
    return SETUP_ERRORS[error.code] ?? 'Something went wrong. Try again.'
  }
  return 'Something went wrong. Try again.'
}

/** "3 playlists · 120 liked songs · 2 follows · 1,204 plays". */
export function summaryText(summary: SnapshotSummary): string {
  return [
    countLabel(summary.playlists, 'playlist'),
    countLabel(summary.likes, 'liked song'),
    countLabel(summary.follows, 'follow'),
    countLabel(summary.plays, 'play'),
  ].join(' · ')
}
