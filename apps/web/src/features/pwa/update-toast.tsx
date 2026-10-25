import { RefreshCw } from 'lucide-react'
import { buttonClasses } from '../../components/ui/button'
import { usePwaStore } from './pwa-store'

const dismiss = () => usePwaStore.setState({ updateDismissed: true })

/**
 * Offers a waiting new version of FXM, above the player. The app never reloads by itself,
 * because that would stop the music: "Reload" switches to the new version now, "Not now" keeps
 * this one, and the new version starts the next time FXM opens.
 */
export function UpdateToast() {
  const show = usePwaStore((state) => state.updateReady && !state.updateDismissed)
  const applyUpdate = usePwaStore((state) => state.applyUpdate)

  return (
    // The live region stays in the page, so screen readers announce the toast when it appears
    // (a plain live region, like the route announcer's: role="status" is the loading skeleton's).
    // From 768px it centres on the page column, beside the sidebar.
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-safe bottom-[calc(var(--shell-bottom)+0.75rem)] z-50 flex justify-center px-gutter md:pl-[calc(var(--spacing-rail)+var(--spacing-gutter))] lg:pl-[calc(var(--spacing-sidebar)+var(--spacing-gutter))]"
    >
      {show && (
        <div className="pointer-events-auto flex w-full max-w-lg flex-wrap items-center justify-end gap-x-3 gap-y-2 rounded-xl border border-border bg-elevated py-2 pr-2 pl-4 shadow-xl">
          <p className="flex min-w-0 flex-1 basis-52 items-center gap-3 py-1 text-sm font-semibold">
            <RefreshCw aria-hidden="true" className="size-5 shrink-0 text-accent" />A new version of
            FXM is ready.
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              className={buttonClasses({ variant: 'ghost', className: 'px-4' })}
              onClick={dismiss}
            >
              Not now
            </button>
            <button
              type="button"
              className={buttonClasses({ className: 'px-4' })}
              onClick={() => void applyUpdate()}
            >
              Reload
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
