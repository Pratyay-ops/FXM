import { Download } from 'lucide-react'
import { useEffect } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { UpdateToastFrame } from '../pwa/update-toast'
import { type AppUpdateState, type AppUpdateStore, useAppUpdateStore } from './app-update-store'
import { dismissAppUpdate, startAppUpdateChecks } from './checks'
import { apkDownloadUrl, isNewerVersion } from './releases'
import { type AppUpdateSupport, buildAppUpdateSupport } from './support'

/**
 * The version the toast offers: the newest release the last check found, if it is newer than the
 * app, has its APK and the user hasn't answered its offer yet.
 */
export function offeredVersion(state: AppUpdateState, current: string): string | undefined {
  const { latest } = state
  if (latest === null || !latest.hasApk || state.dismissedVersion === latest.version) return
  return isNewerVersion(latest.version, current) ? latest.version : undefined
}

/**
 * The Android app's offer of a new version (stage 6.6), in the frame of the installable web
 * app's update toast (features/pwa), where that one shows: the two never show in the same build.
 * "Download" opens the APK's link, which Android hands to the browser, and "Not now" (or Escape)
 * puts the offer away until a newer version is out; Settings → About keeps offering it. Nothing
 * downloads or installs by itself: Android's installer asks before it updates FXM.
 *
 * It also starts the update checks ({@link startAppUpdateChecks}), so builds that don't check
 * (the web and desktop apps, F-Droid and other builds) neither check nor show anything.
 */
export function AppUpdateToast({
  fullScreen = false,
  support = buildAppUpdateSupport(),
  store = useAppUpdateStore,
}: {
  /** A phone's full-screen page (Now Playing): the toast shows at the top. */
  fullScreen?: boolean
  support?: AppUpdateSupport
  store?: AppUpdateStore
}) {
  useEffect(() => startAppUpdateChecks({ support, store }), [support, store])
  const version = store((state) =>
    support.checks ? offeredVersion(state, support.version) : undefined,
  )
  return (
    <UpdateToastFrame
      show={version !== undefined}
      fullScreen={fullScreen}
      icon={Download}
      message={`FXM ${version} is out.`}
      // "Not now", Escape and Download all answer the offer.
      onDismiss={() => {
        if (version !== undefined) dismissAppUpdate(version, store)
      }}
      action={(dismiss) =>
        version === undefined ? null : (
          // The Android app hands links to other sites to the browser, which downloads it.
          <a
            href={apkDownloadUrl(version)}
            target="_blank"
            rel="noreferrer"
            className={buttonClasses()}
            onClick={dismiss}
          >
            Download<span className="sr-only"> FXM {version}</span>
          </a>
        )
      }
    />
  )
}
