import { UpdateToast } from './update-toast'

/**
 * The installable web app's part of the shell, rendered once by AppLayout: the update toast.
 * The service worker starts in main.tsx.
 */
export function PwaShell() {
  return <UpdateToast />
}
