/**
 * The words the plugins section uses: what each operation means to people, where a plugin came
 * from, and why something failed.
 *
 * @module
 */

import { isFxmError } from '@fxm/core'
import {
  cleanText,
  isPluginError,
  type PluginEntry,
  type PluginOperation,
  type PluginOrigin,
  type PluginProblem,
} from '@fxm/plugins'

/** What each operation adds, for people. */
export const OPERATION_LABELS: Readonly<Record<PluginOperation, string>> = {
  search: 'search',
  suggest: 'search suggestions',
  track: 'songs',
  album: 'albums',
  artist: 'artists',
  playlist: 'playlists',
  radio: 'radio',
  match: 'audio for songs from other sources',
  resolve: 'audio for its songs',
}

/** "a", "a and b", "a, b and c". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** What a plugin adds, as a sentence fragment: "search, albums and audio for its songs". */
export function operationsText(operations: readonly PluginOperation[]): string {
  return listText(operations.map((operation) => OPERATION_LABELS[operation]))
}

/** Where a plugin came from, for people. */
export function originText(origin: PluginOrigin): string {
  return origin.kind === 'url' ? `From ${origin.url}` : `From the file ${origin.name}`
}

/** A short form of a checksum: its first and last eight digits. */
export function shortChecksum(sha256: string): string {
  return `${sha256.slice(0, 8)}…${sha256.slice(-8)}`
}

/** "Test Catalog 1.2.0", or the name alone when a damaged copy names no version. */
export function pluginTitle(entry: Pick<PluginEntry, 'name' | 'version'>): string {
  return entry.version === undefined ? entry.name : `${entry.name} ${entry.version}`
}

/** Why an installed plugin can't run, in words, as a sentence. */
export function problemText(problem: PluginProblem): string {
  switch (problem.code) {
    case 'needs-newer-fxm':
      return `It needs FXM ${problem.minFxmVersion} or later, and this is FXM ${problem.appVersion}. Update FXM, or add a version of the plugin that runs on this one.`
    default:
      return 'Its stored copy is damaged, so it doesn’t run. Remove it, or add it again.'
  }
}

/** A message as a sentence: cleaned, with one full stop at the end. */
function sentence(message: string, max: number): string {
  return `${cleanText(message, max).replace(/[.\s]+$/u, '')}.`
}

/** Why adding, updating or changing a plugin failed, in words. */
export function pluginFailureText(error: unknown): string {
  if (isPluginError(error)) {
    switch (error.pluginCode) {
      case 'download-failed':
        return `${sentence(error.message, 200)} Check the address and your connection, and try again.`
      case 'checksum-mismatch':
        return 'The plugin’s code isn’t the code its manifest declares, so FXM won’t run it. Ask its author for a fixed version.'
      case 'invalid-manifest':
        return sentence(`This isn’t a plugin FXM can add: ${error.message}`, 240)
      case 'unavailable':
        return 'Plugins can’t run in this browser: it can’t start the separate worker each plugin runs in.'
      default:
        return sentence(error.message, 240)
    }
  }
  if (isFxmError(error, 'Unsupported')) {
    return 'FXM can’t reach that address from here.'
  }
  return 'Something went wrong. Try again.'
}
