import { useLaunchQueue } from './launch-queue'
import { useTitleBar } from './title-bar'
import { UpdateToast } from './update-toast'

/**
 * The installable web app's part of the shell, rendered once by AppLayout: the update toast,
 * the title bar of a desktop window in Window Controls Overlay mode, and launches of the open
 * app window. The service worker and the install offer start in main.tsx; the media keys come
 * with the app's player (features/now-playing/playback.ts).
 */
export function PwaShell({
  fullScreen = false,
}: {
  /**
   * The page fills a phone's screen with its own player controls (Now Playing), so the update
   * toast shows at the top instead of over them.
   */
  fullScreen?: boolean
}) {
  useLaunchQueue()
  useTitleBar()
  return <UpdateToast fullScreen={fullScreen} />
}
