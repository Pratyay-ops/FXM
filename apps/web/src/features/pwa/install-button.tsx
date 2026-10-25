import type { RefObject } from 'react'
import { moveFocus } from './focus'
import { promptInstall, useInstallOffer } from './install'
import { InstallIcon } from './install-icon'

/**
 * "Install app" in the top bar from 768px, while the browser offers to install FXM (Chromium's
 * `beforeinstallprompt`) and the user hasn't put the offer off. Phones get the offer on the Home
 * page instead (`InstallCard`), where it doesn't crowd the page title.
 *
 * The offer is used up by the click, so the button goes: focus moves to `focusAfter` (the top
 * bar's Settings link) first.
 */
export function InstallButton({ focusAfter }: { focusAfter?: RefObject<HTMLElement | null> }) {
  const offer = useInstallOffer()
  if (!offer) return null
  return (
    <button
      type="button"
      onClick={() => {
        moveFocus(focusAfter?.current)
        void promptInstall()
      }}
      // A pill with its label: 44px tall below 1024px and on touch screens.
      className="hidden h-touch shrink-0 items-center justify-center gap-2 rounded-full bg-elevated px-4 text-sm font-semibold whitespace-nowrap text-text transition-colors hover:bg-elevated-hover md:inline-flex lg:h-9 lg:pointer-coarse:h-touch [&_svg]:size-4 [&_svg]:shrink-0"
    >
      <InstallIcon />
      Install app
    </button>
  )
}
