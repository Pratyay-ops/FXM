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
  track: 'song details',
  album: 'albums',
  artist: 'artists',
  playlist: 'playlists',
  radio: 'radio',
  match: 'audio for songs from other sources',
  resolve: 'audio for its songs',
}

/**
 * The operations this version of FXM uses, so what a plugin's approval says it adds is only
 * what it will do: its catalog in search (only with its source picked) and its album, artist
 * and playlist pages, and the audio of its own songs. The others are ready in `@fxm/plugins` but
 * unused: search suggestions (a plugin is a source to call only on request, so the search box
 * never asks it as the user types), single songs by ID, radio and matching for songs from other
 * sources (the radio and the matching engine don't follow plugins yet; see the README).
 */
export const USED_OPERATIONS: ReadonlySet<PluginOperation> = new Set([
  'search',
  'album',
  'artist',
  'playlist',
  'resolve',
])

/** The operations of `operations` this version of FXM uses, and those it doesn't. */
export function splitOperations(operations: readonly PluginOperation[]): {
  used: PluginOperation[]
  unused: PluginOperation[]
} {
  return {
    used: operations.filter((operation) => USED_OPERATIONS.has(operation)),
    unused: operations.filter((operation) => !USED_OPERATIONS.has(operation)),
  }
}

/** "a", "a and b", "a, b and c". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** Operations as a sentence fragment: "search, albums and audio for its songs". */
export function operationsText(operations: readonly PluginOperation[]): string {
  return listText(operations.map((operation) => OPERATION_LABELS[operation]))
}

/**
 * What a plugin adds to this version of FXM, as sentences: "It adds search, albums and audio for
 * its songs." for what FXM uses, then "It also offers radio, which this version of FXM doesn't
 * use." for what it declares beyond that. `subject` starts them ("It" in the approval, "" for
 * the installed plugin's "Adds …").
 */
export function operationsSentences(
  operations: readonly PluginOperation[],
  subject: 'It' | '' = 'It',
): string[] {
  const { used, unused } = splitOperations(operations)
  const lead = (verb: string) => (subject === '' ? capitalize(verb) : `${subject} ${verb}`)
  const sentences: string[] = []
  if (used.length > 0) sentences.push(`${lead('adds')} ${operationsText(used)}.`)
  if (unused.length > 0) {
    const also = used.length > 0 ? 'also offers' : 'offers'
    sentences.push(
      `${lead(also)} ${operationsText(unused)}, which this version of FXM doesn’t use.`,
    )
  }
  return sentences
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
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
