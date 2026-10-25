import { type AppPlayerSource, appPlayerSource } from './integration'
import { useLaunchQueue } from './launch-queue'
import { useMediaKeys } from './media-keys'
import { TitleBar } from './title-bar'
import { UpdateToast } from './update-toast'

/**
 * The installable web app's part of the shell, rendered once by AppLayout: the title bar of a
 * desktop window in Window Controls Overlay mode, the update toast, the media keys and launches
 * of the open app window. The service worker and the install offer start in main.tsx.
 */
export function PwaShell({
  title,
  players = appPlayerSource,
}: {
  /** The page title (the route's handle), for the title bar. */
  title: string | undefined
  /** Where the app's player comes from (tests pass their own). */
  players?: AppPlayerSource
}) {
  useMediaKeys(players.usePlayer())
  useLaunchQueue()
  return (
    <>
      <TitleBar title={title} />
      <UpdateToast />
    </>
  )
}
