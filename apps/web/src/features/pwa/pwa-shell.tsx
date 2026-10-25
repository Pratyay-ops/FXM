import { type AppPlayerSource, appPlayerSource } from './integration'
import { useLaunchQueue } from './launch-queue'
import { useMediaKeys } from './media-keys'
import { useTitleBar } from './title-bar'
import { UpdateToast } from './update-toast'

/**
 * The installable web app's part of the shell, rendered once by AppLayout: the update toast,
 * the title bar of a desktop window in Window Controls Overlay mode, the media keys and
 * launches of the open app window. The service worker and the install offer start in main.tsx.
 */
export function PwaShell({
  fullScreen = false,
  players = appPlayerSource,
}: {
  /**
   * The page fills a phone's screen with its own player controls (Now Playing), so the update
   * toast shows at the top instead of over them.
   */
  fullScreen?: boolean
  /** Where the app's player comes from (tests pass their own). */
  players?: AppPlayerSource
}) {
  useMediaKeys(players.usePlayer())
  useLaunchQueue()
  useTitleBar()
  return <UpdateToast fullScreen={fullScreen} />
}
