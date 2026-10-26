import { MonitorDown, SquarePlus } from 'lucide-react'

/**
 * The install icon: a screen with an arrow with a mouse (installing a desktop app), a square
 * with a plus on touch screens (adding to the home screen). Not a plain down arrow, which reads
 * as "download" in a music app.
 */
export function InstallIcon() {
  return (
    <>
      <MonitorDown aria-hidden="true" className="pointer-coarse:hidden" />
      <SquarePlus aria-hidden="true" className="not-pointer-coarse:hidden" />
    </>
  )
}
