import { useLaunchQueue } from './launch-queue'
import { TitleBar } from './title-bar'
import { UpdateToast } from './update-toast'

/**
 * The installable web app's part of the shell, rendered once by AppLayout: the title bar of a
 * desktop window in Window Controls Overlay mode, the update toast and launches of the open app
 * window. The service worker and the install offer start in main.tsx.
 */
export function PwaShell({
  title,
}: {
  /** The page title (the route's handle), for the title bar. */
  title: string | undefined
}) {
  useLaunchQueue()
  return (
    <>
      <TitleBar title={title} />
      <UpdateToast />
    </>
  )
}
