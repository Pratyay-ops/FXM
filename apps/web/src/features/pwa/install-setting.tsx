import { buttonClasses } from '../../components/ui/button'
import { moveFocus } from './focus'
import { type InstallHint, promptInstall, useInstallHint } from './install'
import { InstallIcon } from './install-icon'

/** What the "Install app" setting says, for each way of installing. */
export const INSTALL_HELP: Readonly<Record<InstallHint, string>> = {
  installed: "You're using FXM as an installed app.",
  added: 'FXM is installed. Open it from your dock, taskbar or home screen.',
  prompt: 'Opens FXM in its own window, from your dock, taskbar or home screen.',
  ios: 'Tap Share in your browser, then Add to Home Screen.',
  'mac-safari': 'In Safari, choose File, then Add to Dock.',
  browser: 'If your browser can install web apps, choose Install in its menu or address bar.',
}

/**
 * The help text of the "Install app" setting: how to install FXM in this browser. It takes
 * focus when the Install button goes (the offer is used up), and announces what changed.
 */
export function InstallHelp({ id }: { id?: string }) {
  const hint = useInstallHint()
  return (
    <p id={id} tabIndex={-1} aria-live="polite" className="text-sm text-text-muted outline-none">
      {INSTALL_HELP[hint]}
    </p>
  )
}

/** The "Install" button of the setting, while the browser offers to install FXM. */
export function InstallAction({ describedBy }: { describedBy?: string }) {
  const hint = useInstallHint()
  if (hint !== 'prompt') return null
  return (
    <button
      type="button"
      aria-describedby={describedBy}
      className={buttonClasses({ className: 'w-full md:w-auto' })}
      onClick={() => {
        // The click uses the offer up and removes this button: keep focus in the setting.
        moveFocus(describedBy ? document.getElementById(describedBy) : null)
        void promptInstall()
      }}
    >
      <InstallIcon />
      Install
    </button>
  )
}
