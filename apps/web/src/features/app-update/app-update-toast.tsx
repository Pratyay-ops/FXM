import { Download } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { cn } from '../../lib/cn'
import { useMediaQuery } from '../../lib/use-media-query'
import { moveFocus } from '../pwa/focus'
import { PHONE_QUERY, useSpaceAbovePlayer } from '../pwa/update-toast'
import { type AppUpdateState, type AppUpdateStore, useAppUpdateStore } from './app-update-store'
import { dismissAppUpdate, startAppUpdateChecks } from './checks'
import { apkDownloadUrl, isNewerVersion } from './releases'
import { type AppUpdateSupport, buildAppUpdateSupport } from './support'

/**
 * The version the toast offers: the newest release the last check found, if it is newer than the
 * app, has its APK and the user hasn't answered its offer yet.
 */
export function offeredVersion(state: AppUpdateState, current: string): string | undefined {
  const { latest } = state
  if (latest === null || !latest.hasApk || state.dismissedVersion === latest.version) return
  return isNewerVersion(latest.version, current) ? latest.version : undefined
}

/**
 * The Android app's offer of a new version (stage 6.6), where the installable web app offers its
 * own (features/pwa): above the player, or on a phone's full-screen Now Playing below the top bar.
 * "Download" opens the APK's link, which Android hands to the browser, and "Not now" (or Escape)
 * puts the offer away until a newer version is out; Settings → About keeps offering it. Nothing
 * downloads or installs by itself: Android's installer asks before it updates FXM.
 *
 * It also starts the update checks ({@link startAppUpdateChecks}), so builds that don't check
 * (the web and desktop apps, F-Droid builds) neither check nor show anything.
 */
export function AppUpdateToast({
  fullScreen = false,
  support = buildAppUpdateSupport(),
  store = useAppUpdateStore,
}: {
  /** A phone's full-screen page (Now Playing): the toast shows at the top. */
  fullScreen?: boolean
  support?: AppUpdateSupport
  store?: AppUpdateStore
}) {
  useEffect(() => startAppUpdateChecks({ support, store }), [support, store])
  const version = store((state) =>
    support.checks ? offeredVersion(state, support.version) : undefined,
  )
  const phone = useMediaQuery(PHONE_QUERY)
  const toast = useRef<HTMLElement>(null)
  /** The element focus came from when it entered the toast. */
  const cameFrom = useRef<Element | null>(null)
  useSpaceAbovePlayer(toast, version !== undefined && !(fullScreen && phone))

  /** "Not now", Escape or Download: the offer goes, and focus goes back where it came from. */
  const answer = () => {
    if (version === undefined) return
    const hadFocus = toast.current?.contains(document.activeElement) ?? false
    dismissAppUpdate(version, store)
    if (hadFocus) moveFocus(cameFrom.current)
  }

  return (
    // Placed like the installable web app's update toast (features/pwa/update-toast.tsx); the
    // two never show in the same build.
    <div
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed inset-x-safe bottom-[calc(var(--shell-bottom)+var(--shell-cards,0px)+var(--connect-notice-space,0px)+0.75rem)] z-50 flex justify-center px-gutter md:pl-[calc(var(--spacing-rail)+var(--spacing-gutter))] lg:pl-[calc(var(--spacing-sidebar)+var(--spacing-gutter))]',
        fullScreen && 'max-md:top-[calc(var(--shell-top)+0.5rem)] max-md:bottom-auto',
      )}
    >
      {version !== undefined && (
        <section
          ref={toast}
          aria-label="App update"
          className="pointer-events-auto flex w-full max-w-lg flex-wrap items-center justify-end gap-x-3 gap-y-2 rounded-xl border border-border bg-elevated py-2 pr-2 pl-4 shadow-xl"
          onFocus={(event) => {
            const from = event.relatedTarget
            if (!(from instanceof Node && event.currentTarget.contains(from))) {
              cameFrom.current = from instanceof Element ? from : null
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            answer()
          }}
        >
          <p className="flex min-w-0 flex-1 basis-52 items-center gap-3 py-1 text-sm font-semibold">
            <Download aria-hidden="true" className="size-5 shrink-0 text-accent" />
            FXM {version} is out.
          </p>
          {/* Wraps with large text; the gap keeps one button's focus ring off the other. */}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className={buttonClasses({ variant: 'ghost' })}
              onClick={() => answer()}
            >
              Not now
            </button>
            {/* The Android app hands links to other sites to the browser, which downloads it. */}
            <a
              href={apkDownloadUrl(version)}
              target="_blank"
              rel="noreferrer"
              className={buttonClasses()}
              onClick={() => answer()}
            >
              Download<span className="sr-only"> FXM {version}</span>
            </a>
          </div>
        </section>
      )}
    </div>
  )
}
