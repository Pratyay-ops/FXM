/**
 * The third-party notices that the app carries itself, for Settings → About. Every release of the
 * desktop app bundles its own (stage 7.5): the licences of the Rust crates compiled into it and
 * make dist's notices for the web app. Inside Tauri the composition root connects them before the
 * first render (`connectDesktopNotices` in `app/services/desktop.ts`), and About shows them in the
 * app. Elsewhere nothing is connected, and About links the notices that make dist writes next to
 * the web app on FXM's site.
 *
 * @module
 */

/** Reads the notices the app carries, as text. Rejects with the reason when this build has none. */
export type BundledNotices = () => Promise<string>

let connected: BundledNotices | undefined

/** Connects the notices the app carries, or disconnects them with `undefined`. */
export function connectBundledNotices(read: BundledNotices | undefined): void {
  connected = read
}

/** The notices the app carries, if the composition root connected any. */
export function bundledNotices(): BundledNotices | undefined {
  return connected
}
