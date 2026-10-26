import { useId } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { LogoMark } from '../../components/ui/logo'
import { moveFocus } from './focus'
import { promptInstall, snoozeInstallOffer, useInstallOffer } from './install'
import { InstallIcon } from './install-icon'

/**
 * The install offer on phones, near the top of the Home page (from 768px the top bar has an
 * "Install app" button instead). "Not now" puts it off for a month, as closing the browser's
 * install dialog does; Settings → App still offers it. Either button removes the card, so
 * focus moves to the page first.
 */
export function InstallCard() {
  const offer = useInstallOffer()
  const titleId = useId()
  if (!offer) return null
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-border bg-surface p-4 md:hidden"
    >
      <LogoMark className="size-12" />
      <div className="min-w-0 flex-1 basis-40">
        <h2 id={titleId} className="font-bold">
          Install FXM
        </h2>
        <p className="text-sm text-text-muted">
          Open it from your home screen, in a window of its own.
        </p>
      </div>
      <div className="flex flex-1 flex-wrap justify-end gap-2">
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost' })}
          onClick={() => {
            moveFocus()
            snoozeInstallOffer()
          }}
        >
          Not now
        </button>
        <button
          type="button"
          className={buttonClasses()}
          onClick={() => {
            moveFocus()
            void promptInstall()
          }}
        >
          <InstallIcon />
          Install
        </button>
      </div>
    </section>
  )
}
