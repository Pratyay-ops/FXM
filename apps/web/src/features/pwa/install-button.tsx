import { CircleArrowDown } from 'lucide-react'
import { cn } from '../../lib/cn'
import { promptInstall, useRunningAsApp } from './install'
import { usePwaStore } from './pwa-store'

/**
 * "Install app" in the top bar, while the browser offers to install FXM (Chromium's
 * `beforeinstallprompt`). An icon on phones, a labelled pill from 768px.
 */
export function InstallButton() {
  const canPrompt = usePwaStore((state) => state.installPrompt !== undefined)
  const runningAsApp = useRunningAsApp()
  if (!canPrompt || runningAsApp) return null
  return (
    <button
      type="button"
      onClick={() => void promptInstall()}
      className={cn(
        'inline-flex size-touch shrink-0 items-center justify-center gap-2 rounded-full text-text-muted transition-colors hover:bg-text/8 hover:text-text [&_svg]:size-5',
        // From 768px a pill with its label: 44px tall below 1024px and on touch screens.
        'md:w-auto md:bg-elevated md:px-4 md:text-sm md:font-semibold md:text-text md:hover:bg-elevated-hover lg:h-9 lg:pointer-coarse:h-touch md:[&_svg]:size-4',
      )}
    >
      <CircleArrowDown aria-hidden="true" />
      <span className="max-md:sr-only">Install app</span>
    </button>
  )
}
