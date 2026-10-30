import { lazy, Suspense, useState } from 'react'
import { useDownloadDialogStore } from './download-dialog-store'

// The dialog, the downloads' runtime and the converter load the first time it opens.
const DownloadDialog = lazy(() =>
  import('./download-dialog').then((module) => ({ default: module.DownloadDialog })),
)

/**
 * The Download dialog, for the menus and buttons that open it (`openDownloadDialog`), loaded on
 * first use. It stays mounted once loaded, so closing it closes the native dialog, which puts
 * the focus back where it was; its form starts afresh with every request.
 */
export function DownloadDialogHost() {
  const request = useDownloadDialogStore((state) => state.request)
  const close = useDownloadDialogStore((state) => state.close)
  const [wanted, setWanted] = useState(false)
  if (request !== null && !wanted) setWanted(true)
  if (!wanted) return null
  return (
    <Suspense fallback={null}>
      <DownloadDialog request={request} onClose={close} />
    </Suspense>
  )
}
