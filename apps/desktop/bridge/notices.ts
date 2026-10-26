/**
 * The third-party notices that every release of the desktop app carries (stage 7.5), for Settings
 * → About: the licences of the Rust crates compiled into the app and make dist's notices for the
 * web app, which the shell reads from its resources (`src-tauri/src/notices.rs`).
 *
 * Tauri's JavaScript bindings load on first use, so a browser never downloads them.
 *
 * @module
 */

import { loadShellBindings, type ShellInvoke } from './shell'

/** The shell's command that reads the notices, behind its `allow-third-party-notices` permission. */
export const NOTICES_COMMAND = 'third_party_notices'

/** Tauri's `invoke`, or a function that loads it: all that reading the notices needs. */
export type NoticesBindings =
  | { readonly invoke: ShellInvoke }
  | (() => Promise<{ readonly invoke: ShellInvoke }>)

/**
 * Reads the third-party notices that the desktop app carries, as text. Rejects with the shell's
 * reason when it can't, such as a local or development build, which carries no notices file.
 */
export async function readThirdPartyNotices(
  bindings: NoticesBindings = loadShellBindings,
): Promise<string> {
  const { invoke } = typeof bindings === 'function' ? await bindings() : bindings
  const notices = await invoke<unknown>(NOTICES_COMMAND)
  if (typeof notices !== 'string') throw new Error('The desktop app sent no third-party notices')
  return notices
}
