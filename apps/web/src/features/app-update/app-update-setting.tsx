import { useId } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { playedLabel } from '../library/format'
import { SettingRow } from '../settings/settings-layout'
import { type AppUpdateState, type AppUpdateStore, useAppUpdateStore } from './app-update-store'
import { checkForAppUpdate } from './checks'
import { apkDownloadUrl, isNewerVersion, RELEASES_REPOSITORY, releasePageUrl } from './releases'
import { type AppUpdateSupport, buildAppUpdateSupport } from './support'

/** How to install an update, in the Android app's install guide. */
export const INSTALL_GUIDE_URL = `https://github.com/${RELEASES_REPOSITORY}/blob/main/apps/mobile/INSTALL.md#updates`

const PROBLEMS: Record<NonNullable<AppUpdateState['problem']>, string> = {
  offline: "Couldn't check: this device is offline. FXM checks again once it is online.",
  'rate-limited':
    "Couldn't check: GitHub has had too many requests from this connection. FXM tries again later.",
  unreachable: "Couldn't reach GitHub. FXM tries again later.",
  unexpected: "GitHub's answer didn't make sense to FXM. It tries again later.",
}

/**
 * A link to GitHub, like the other settings' links. The Android app hands it to the browser, and
 * says so to screen readers.
 */
function ExternalLinkText({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-semibold text-text underline underline-offset-2 hover:text-accent"
    >
      {children}
      <span className="sr-only"> (opens your browser)</span>
    </a>
  )
}

/** What the last check found, in a sentence or two. */
function Status({ state, current, now }: { state: AppUpdateState; current: string; now: number }) {
  const { latest } = state
  if (state.checking) return <p>Checking…</p>
  if (latest !== null && isNewerVersion(latest.version, current)) {
    return (
      <p>
        <strong className="font-semibold text-text">FXM {latest.version} is out.</strong>{' '}
        {latest.hasApk ? (
          <>
            <ExternalLinkText href={apkDownloadUrl(latest.version)}>
              Download the APK
            </ExternalLinkText>{' '}
            and open it to update FXM.{' '}
          </>
        ) : (
          "Its APK isn't there yet. "
        )}
        <ExternalLinkText href={releasePageUrl(latest.version)}>What's new</ExternalLinkText>
      </p>
    )
  }
  if (state.problem !== null) return <p>{PROBLEMS[state.problem]}</p>
  if (state.lastCheckedAt === 0) return <p>Not checked yet.</p>
  return <p>You have the latest version. Checked {playedLabel(state.lastCheckedAt, now)}.</p>
}

/**
 * Settings → About → Updates (stage 6.6), in the Android app only: what the daily check found,
 * the newest APK's link and "Check now". F-Droid builds say that F-Droid updates them; the web
 * and desktop apps show nothing, because they update otherwise.
 */
export function AppUpdateSetting({
  support = buildAppUpdateSupport(),
  store = useAppUpdateStore,
  now = Date.now,
  check = () => checkForAppUpdate({ store }),
}: {
  support?: AppUpdateSupport
  store?: AppUpdateStore
  now?: () => number
  /** "Check now". Default: {@link checkForAppUpdate} with the app's GitHub request. */
  check?: () => Promise<void>
}) {
  const labelId = useId()
  const helpId = useId()
  const state = store()
  if (!support.checks && support.reason !== 'fdroid') return null
  if (!support.checks) {
    return (
      <div className="p-4 sm:p-5">
        <p id={labelId} className="font-semibold">
          Updates
        </p>
        <p className="mt-1 text-sm text-text-muted">
          F-Droid updates this app. FXM doesn't check for new versions itself in F-Droid builds.
        </p>
      </div>
    )
  }
  return (
    <SettingRow
      label="Updates"
      labelId={labelId}
      help={
        <div id={helpId} className="space-y-2 text-sm text-text-muted">
          {/* Announced when a check ends; the paragraph below never changes. */}
          <div aria-live="polite">
            <Status state={state} current={support.version} now={now()} />
          </div>
          <p>
            Once a day, FXM asks GitHub whether a new version is out, and tells you. It never
            downloads or installs anything by itself: Android asks you before it updates FXM.{' '}
            <ExternalLinkText href={INSTALL_GUIDE_URL}>How updates install</ExternalLinkText>
          </p>
        </div>
      }
    >
      <button
        type="button"
        aria-describedby={helpId}
        className={buttonClasses({ variant: 'secondary', className: 'w-full md:w-auto' })}
        // Never disabled, so it keeps focus: a click during a check joins it.
        onClick={() => void check()}
      >
        Check now
      </button>
    </SettingRow>
  )
}
