/**
 * Loading Tauri's JavaScript bindings once, on first use, so a browser never downloads them.
 *
 * @module
 */

/** A value, or a function that loads it. */
export type Loadable<T extends object> = T | (() => Promise<T>)

/** `source`, loaded once; a load that failed is tried again on the next call. */
export function loadOnce<T extends object>(source: Loadable<T>): () => Promise<T> {
  if (typeof source !== 'function') return async () => source
  let loading: Promise<T> | undefined
  return () => {
    loading ??= source().catch((error: unknown) => {
      loading = undefined
      throw error
    })
    return loading
  }
}

/** The `code` of an error a Rust command answered (`{ code, message }`), if it has one. */
export function commandErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof error === 'object' && error !== null && typeof code === 'string' ? code : undefined
}

/** The message of an error of any kind: an `Error`, a command's `{ code, message }` or a string. */
export function commandErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error !== '') return error
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message !== '' ? message : fallback
}

/** An error a desktop command answered, with its `code` (see each Rust module's list). */
export class DesktopCommandError extends Error {
  override readonly name = 'DesktopCommandError'
  /** What went wrong, for code; `unknown` when the answer named nothing. */
  readonly code: string

  constructor(error: unknown, fallback: string) {
    super(commandErrorMessage(error, fallback), { cause: error })
    this.code = commandErrorCode(error) ?? 'unknown'
  }
}
