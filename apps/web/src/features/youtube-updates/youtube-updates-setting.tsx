import {
  CODE_UPDATES_CONSENT,
  type Distribution,
  detectEnvironment,
  type Environment,
} from '@fxm/platform'
import { useId, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { BUILD_DISTRIBUTION } from '../../lib/distribution'
import { SettingSwitch } from '../settings/setting-switch'
import { SettingRow } from '../settings/settings-layout'
import { useYouTubeUpdatesStore, type YouTubeUpdatesStore } from './youtube-updates-store'

/** Where the setting shows: F-Droid builds of the apps that load downloaded code. */
export function asksForYouTubeUpdates(
  distribution: Distribution = BUILD_DISTRIBUTION,
  environment: Environment = detectEnvironment(),
): boolean {
  // The web app never loads code from FXM's website (its policy has no blob: in script-src), so
  // only the Android app, the one F-Droid builds, and the desktop app could ask.
  return distribution === 'fdroid' && (environment === 'capacitor' || environment === 'tauri')
}

/**
 * The opt-in itself, with the words F-Droid's inclusion policy asks for: what the code is, that
 * it comes from FXM and not F-Droid, and that turning it on bypasses F-Droid's checks. Both
 * answers are buttons of the same style, and neither is preselected.
 */
function OptIn({ onAccept, onDecline }: { onAccept: () => void; onDecline: () => void }) {
  return (
    <fieldset className="min-w-0 space-y-3 p-4 sm:p-5">
      <legend className="float-left w-full font-semibold">{CODE_UPDATES_CONSENT.title}</legend>
      <div className="clear-left space-y-2 text-sm text-text-muted">
        {CODE_UPDATES_CONSENT.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary' })}
          onClick={onAccept}
        >
          {CODE_UPDATES_CONSENT.accept}
        </button>
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary' })}
          onClick={onDecline}
        >
          {CODE_UPDATES_CONSENT.decline}
        </button>
      </div>
    </fieldset>
  )
}

/** Props for {@link YouTubeUpdatesSetting}; the defaults are the app's. Tests pass their own. */
export interface YouTubeUpdatesSettingProps {
  distribution?: Distribution
  environment?: Environment
  store?: YouTubeUpdatesStore
}

/**
 * Settings → Sources, in F-Droid builds only (stage R.3): whether FXM may download the signed
 * YouTube fixes that its website publishes between app releases (stage 1.13). Off until the
 * user turns it on; turning it off goes back to the YouTube code the app came with.
 */
export function YouTubeUpdatesSetting({
  distribution,
  environment,
  store = useYouTubeUpdatesStore,
}: YouTubeUpdatesSettingProps) {
  const optedIn = store((state) => state.optedIn)
  const setOptedIn = store((state) => state.setOptedIn)
  const [declined, setDeclined] = useState(false)
  const labelId = useId()
  const helpId = useId()
  if (!asksForYouTubeUpdates(distribution, environment)) return null

  if (optedIn) {
    return (
      <SettingRow
        label={CODE_UPDATES_CONSENT.setting}
        labelId={labelId}
        help={
          <p id={helpId} className="text-sm text-text-muted">
            On. When the app starts, FXM checks its website for YouTube fixes signed by its
            developer. They come from FXM, not from F-Droid.
          </p>
        }
      >
        <SettingSwitch
          labelledBy={labelId}
          describedBy={helpId}
          checked
          onChange={(checked) => setOptedIn(checked)}
        />
      </SettingRow>
    )
  }
  if (declined) {
    return (
      <SettingRow
        label="YouTube fixes from FXM"
        labelId={labelId}
        help={
          <p id={helpId} className="text-sm text-text-muted">
            Off. FXM uses the YouTube code this version came with, and F-Droid’s next update brings
            newer code.
          </p>
        }
      >
        <button
          type="button"
          aria-describedby={helpId}
          className={buttonClasses({ variant: 'secondary' })}
          onClick={() => setDeclined(false)}
        >
          Turn on…
        </button>
      </SettingRow>
    )
  }
  return <OptIn onAccept={() => setOptedIn(true)} onDecline={() => setDeclined(true)} />
}
