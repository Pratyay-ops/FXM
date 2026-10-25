import { CircleArrowDown } from 'lucide-react'
import { buttonClasses } from '../../components/ui/button'
import { type InstallHint, promptInstall, useInstallHint } from './install'

/** What the "Install app" setting says, for each way of installing. */
export const INSTALL_HELP: Readonly<Record<InstallHint, string>> = {
  installed: "You're using FXM as an installed app.",
  prompt: 'Opens FXM in its own window, from your dock, taskbar or home screen.',
  ios: 'Tap Share in your browser, then Add to Home Screen.',
  'mac-safari': 'In Safari, choose File, then Add to Dock.',
  browser: 'If your browser can install web apps, choose Install in its menu or address bar.',
}

/** The help text of the "Install app" setting: how to install FXM in this browser. */
export function InstallHelp({ id }: { id?: string }) {
  const hint = useInstallHint()
  return (
    <p id={id} className="text-sm text-text-muted">
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
      onClick={() => void promptInstall()}
    >
      <CircleArrowDown aria-hidden="true" />
      Install
    </button>
  )
}
