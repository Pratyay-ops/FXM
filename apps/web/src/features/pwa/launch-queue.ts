import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

/** What a launch hands the page (the Launch Handler API, not in TypeScript's DOM types). */
export interface LaunchParams {
  readonly targetURL?: string | null
}

/** `window.launchQueue`: the launches the browser hands an open app window. */
export interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void
}

/** `window.launchQueue`, where the browser has it (Chromium). */
export function launchQueue(win: Window | undefined = globalThis.window): LaunchQueue | undefined {
  const queue = (win as (Window & { launchQueue?: unknown }) | undefined)?.launchQueue
  return typeof queue === 'object' &&
    queue !== null &&
    typeof (queue as Partial<LaunchQueue>).setConsumer === 'function'
    ? (queue as LaunchQueue)
    : undefined
}

/**
 * The in-app path a launch asks for (`/library`, with any query and hash), or `undefined` to stay
 * where the user is: a URL outside the app, or the app's start URL, which is what a plain
 * relaunch from the dock, taskbar or Start menu asks for.
 */
export function launchPath(
  targetURL: string | null | undefined,
  base: string,
  origin: string,
): string | undefined {
  if (!targetURL) return undefined
  let url: URL
  try {
    url = new URL(targetURL)
  } catch {
    return undefined
  }
  if (url.origin !== origin || !url.pathname.startsWith(base)) return undefined
  const path = `/${url.pathname.slice(base.length)}`
  if (path === '/' && !url.search && !url.hash) return undefined
  return `${path}${url.search}${url.hash}`
}

/**
 * Handles launches of the installed app while it is open. The manifest's `launch_handler`
 * (`focus-existing`) brings the open window to the front instead of starting a second player;
 * this opens what the launch asked for, such as the Search shortcut, inside the app, so the
 * music keeps playing. A plain relaunch only focuses the window.
 */
export function useLaunchQueue(base: string = import.meta.env.BASE_URL): void {
  const navigate = useNavigate()
  const { pathname, search, hash } = useLocation()
  const current = useRef('')

  useEffect(() => {
    current.current = `${pathname}${search}${hash}`
  }, [pathname, search, hash])

  useEffect(() => {
    launchQueue()?.setConsumer((params) => {
      const path = launchPath(params.targetURL, base, window.location.origin)
      if (path !== undefined && path !== current.current) void navigate(path)
    })
  }, [navigate, base])
}
