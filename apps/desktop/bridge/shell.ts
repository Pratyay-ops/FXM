/**
 * The web app's client for the desktop shell's playback commands and events (stage 7.3), whose
 * Rust side lives in `src-tauri/src/`: `playback.rs`, `tray.rs`, `environment.rs` and
 * `network.rs`.
 *
 * Tauri's JavaScript bindings load on first use, so a browser never downloads them.
 *
 * @module
 */

/** The shell's commands the bridge calls, each behind an `allow-…` permission. */
export const SHELL_COMMANDS = {
  /** Tells the shell what the player is doing: {@link NowPlaying}. */
  setNowPlaying: 'set_now_playing',
  /** Where the app runs: {@link DesktopEnvironment}. */
  environment: 'desktop_environment',
} as const

/** The events the shell sends the main window. */
export const SHELL_EVENTS = {
  /** A tray menu item asks the player to act, with a {@link MediaAction} as its payload. */
  mediaAction: 'fxm-media-action',
  /** The network changed: stream URLs resolved before now may no longer work. No payload. */
  networkChange: 'fxm-network-change',
} as const

/** What a tray menu item asks the player to do. */
export type MediaAction = 'toggle' | 'next' | 'previous'

/** Every {@link MediaAction}. */
export const MEDIA_ACTIONS: readonly MediaAction[] = ['toggle', 'next', 'previous']

/**
 * What the player is doing, as the tray shows it:
 *
 * - `playing`: audio plays, or the next track loads (the player is `playing` or `loading`)
 * - `error`: playback stopped on a failure the user must look at in FXM's window, such as a
 *   bot check, or too many tracks that failed in a row
 * - `paused`: anything else: paused, stopped, ended or not started
 */
export type PlaybackState = 'playing' | 'paused' | 'error'

/** Every {@link PlaybackState}. */
export const PLAYBACK_STATES: readonly PlaybackState[] = ['playing', 'paused', 'error']

/** What the player is doing, as the tray menu shows it. */
export interface NowPlaying {
  /** What the player is doing. Without a track, always `paused`. */
  readonly state: PlaybackState
  /** The current track's title, while the queue has one. */
  readonly title?: string
  /** The current track's artists, as one line. */
  readonly artist?: string
}

/** A valid surrogate pair (kept), or a lone surrogate (replaced). */
const SURROGATES = /([\uD800-\uDBFF][\uDC00-\uDFFF])|[\uD800-\uDFFF]/g

/**
 * `text` with each lone UTF-16 surrogate replaced by U+FFFD, the replacement character. Tauri's
 * IPC sends JSON, which keeps a lone surrogate as an escape such as `\ud83c`, and Rust's JSON
 * parser refuses one, so the whole command would fail: a title cut in the middle of an emoji
 * would never reach the tray. (`String.prototype.toWellFormed` does the same, but WebKit has it
 * only from Safari 16.4.)
 */
export function wellFormed(text: string): string {
  return text.replace(SURROGATES, (_match, pair: string | undefined) => pair ?? '�')
}

/** Where the desktop app runs, as its Rust side reports it. */
export interface DesktopEnvironment {
  /** The operating system: `macos`, `windows` or `linux`. */
  readonly os: string
  /** Its version, such as `15.5.0`, where the shell reads it (macOS only for now). */
  readonly osVersion?: string
  /** The webview's version: WebKit's, WebView2's or WebKitGTK's. */
  readonly webviewVersion?: string
  /** Whether the app has a tray icon. */
  readonly tray: boolean
}

/** Tauri's `invoke`, which calls one of the desktop app's Rust commands. */
export type ShellInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

/** Tauri's `listen`, which subscribes to an event from Rust. */
export type ShellListen = <T>(
  event: string,
  handler: (event: { readonly payload: T }) => void,
) => Promise<() => void>

/** What the bridge takes from Tauri's JavaScript bindings. */
export interface ShellBindings {
  /** `invoke` from `@tauri-apps/api/core`. */
  readonly invoke: ShellInvoke
  /** `listen` from `@tauri-apps/api/event`. */
  readonly listen: ShellListen
}

/** Tauri's bindings, or a function that loads them. */
export type ShellBindingsSource = ShellBindings | (() => Promise<ShellBindings>)

/** Loads Tauri's bindings. Imported on first use, so a browser never downloads them. */
export async function loadShellBindings(): Promise<ShellBindings> {
  const [core, event] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ])
  return { invoke: core.invoke, listen: (name, handler) => event.listen(name, handler) }
}

/** The desktop shell, as the web app's player talks to it. */
export interface DesktopShell {
  /** Where the app runs. */
  environment(): Promise<DesktopEnvironment>
  /**
   * Tells the shell what the player is doing, for the tray's menu and tooltip. Lone surrogates
   * in the text become U+FFFD on the way ({@link wellFormed}).
   */
  setNowPlaying(now: NowPlaying): Promise<void>
  /** Calls `listener` with each media action from the tray. Returns a function that stops it. */
  onMediaAction(listener: (action: MediaAction) => void): () => void
  /** Calls `listener` whenever the network changed. Returns a function that stops it. */
  onNetworkChange(listener: () => void): () => void
}

/** The bindings from `source`, loaded once; a failed load is tried again on the next call. */
function bindingsOnce(source: ShellBindingsSource): () => Promise<ShellBindings> {
  if (typeof source !== 'function') return async () => source
  let loading: Promise<ShellBindings> | undefined
  return () => {
    loading ??= source().catch((error: unknown) => {
      loading = undefined
      throw error
    })
    return loading
  }
}

function isMediaAction(value: unknown): value is MediaAction {
  return MEDIA_ACTIONS.includes(value as MediaAction)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The environment the shell answered, checked: anything malformed is left out. */
export function parseEnvironment(value: unknown): DesktopEnvironment {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const osVersion = optionalString(raw.osVersion)
  const webviewVersion = optionalString(raw.webviewVersion)
  return {
    os: optionalString(raw.os) ?? 'unknown',
    ...(osVersion === undefined ? {} : { osVersion }),
    ...(webviewVersion === undefined ? {} : { webviewVersion }),
    tray: raw.tray === true,
  }
}

/** Options for {@link createDesktopShell}. */
export interface DesktopShellOptions {
  /** Tauri's bindings. Default: {@link loadShellBindings}, on first use. */
  bindings?: ShellBindingsSource
  /** Where a failed subscription is reported. Default: `console.error`. */
  onError?: (error: unknown) => void
}

/**
 * Creates the client for the desktop shell. Subscriptions take effect once Tauri's bindings
 * have loaded; a function returned by one stops it whenever it is called, even before then.
 */
export function createDesktopShell(options: DesktopShellOptions = {}): DesktopShell {
  const bindings = bindingsOnce(options.bindings ?? loadShellBindings)
  const onError = options.onError ?? ((error: unknown) => console.error(error))

  function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
    let stopped = false
    let unlisten: (() => void) | undefined
    bindings()
      .then((tauri) => tauri.listen<T>(event, ({ payload }) => handler(payload)))
      .then(
        (stop) => {
          if (stopped) stop()
          else unlisten = stop
        },
        (error: unknown) => {
          if (!stopped) onError(error)
        },
      )
    return () => {
      stopped = true
      unlisten?.()
      unlisten = undefined
    }
  }

  return {
    async environment() {
      const { invoke } = await bindings()
      return parseEnvironment(await invoke<unknown>(SHELL_COMMANDS.environment))
    },
    async setNowPlaying(now) {
      const { invoke } = await bindings()
      await invoke<void>(SHELL_COMMANDS.setNowPlaying, {
        now: {
          state: now.state,
          ...(now.title === undefined ? {} : { title: wellFormed(now.title) }),
          ...(now.artist === undefined ? {} : { artist: wellFormed(now.artist) }),
        },
      })
    },
    onMediaAction(listener) {
      return subscribe<unknown>(SHELL_EVENTS.mediaAction, (payload) => {
        if (isMediaAction(payload)) listener(payload)
      })
    },
    onNetworkChange(listener) {
      return subscribe<unknown>(SHELL_EVENTS.networkChange, () => listener())
    },
  }
}
