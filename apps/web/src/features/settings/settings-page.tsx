import { APP_NAME, APP_TAGLINE, APP_VERSION } from '@fxm/core'
import { ExternalLink } from 'lucide-react'
import { useId } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { LogoMark } from '../../components/ui/logo'
import { PageTitle } from '../../components/ui/page'
import { SegmentedControl } from '../../components/ui/segmented-control'
import { InstallAction, InstallHelp } from '../pwa/install-setting'
import { isInstallableWebApp } from '../pwa/web-app'
import { SpotifySwitchControl, SpotifySwitchHelp } from '../search/spotify-setting'
import { SponsorBlockCredit, SponsorBlockSetting } from '../sponsorblock/sponsorblock-setting'
import { SyncSettings } from '../sync/sync-settings'
import { CatalogModeControl } from './catalog-mode-control'
import { CATALOG_MODE_DESCRIPTIONS, THEME_OPTIONS } from './options'
import { ASSUMED_CAPABILITIES } from './quality-options'
import { QualitySection } from './quality-section'
import { SettingRow, SettingsSection } from './settings-layout'
import { useSettingsStore } from './settings-store'

export const REPOSITORY_URL = 'https://github.com/Pratyay-ops/FXM'

export function SettingsPage() {
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const theme = useSettingsStore((state) => state.theme)
  const setTheme = useSettingsStore((state) => state.setTheme)
  const modeLabelId = useId()
  const modeHelpId = useId()
  const themeLabelId = useId()
  const spotifyLabelId = useId()
  const spotifyHelpId = useId()
  const installLabelId = useId()
  const installHelpId = useId()

  return (
    <div className="max-w-3xl space-y-8 pt-2 md:pt-4">
      <PageTitle hideOnPhone>Settings</PageTitle>

      <SettingsSection title="Playback">
        <SettingRow
          label="Catalog mode"
          labelId={modeLabelId}
          help={
            <p id={modeHelpId} aria-live="polite" className="text-sm text-text-muted">
              {CATALOG_MODE_DESCRIPTIONS[catalogMode]}
            </p>
          }
        >
          <CatalogModeControl
            labelledBy={modeLabelId}
            describedBy={modeHelpId}
            className="w-full md:w-auto"
          />
        </SettingRow>
        <SponsorBlockSetting />
      </SettingsSection>

      <SettingsSection title="Sources">
        <SettingRow
          label="Spotify"
          labelId={spotifyLabelId}
          help={<SpotifySwitchHelp id={spotifyHelpId} />}
        >
          <SpotifySwitchControl
            labelledBy={spotifyLabelId}
            describedBy={spotifyHelpId}
            className="w-full md:w-auto"
          />
        </SettingRow>
      </SettingsSection>

      {/* The platform's capabilities once the app has them (stage 2.9). */}
      <QualitySection capabilities={ASSUMED_CAPABILITIES} />

      <SettingsSection title="Appearance">
        <SettingRow
          label="Theme"
          labelId={themeLabelId}
          help={
            <p className="text-sm text-text-muted">
              System follows your device's light or dark setting.
            </p>
          }
        >
          <SegmentedControl
            label="Theme"
            labelledBy={themeLabelId}
            value={theme}
            options={THEME_OPTIONS}
            onChange={setTheme}
            className="w-full md:w-auto"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Sync">
        <SyncSettings />
      </SettingsSection>

      {/* Only the web build installs; the Android and desktop apps are installed already. */}
      {isInstallableWebApp() && (
        <SettingsSection title="App">
          <SettingRow
            label="Install app"
            labelId={installLabelId}
            help={<InstallHelp id={installHelpId} />}
          >
            <InstallAction describedBy={installHelpId} />
          </SettingRow>
        </SettingsSection>
      )}

      <SettingsSection title="About">
        <div className="flex flex-col gap-5 p-4 sm:flex-row sm:items-center sm:p-5">
          <LogoMark className="size-14" />
          <div className="min-w-0 flex-1">
            <p className="text-xl font-black tracking-tight">{APP_NAME}</p>
            <p className="text-text-muted">{APP_TAGLINE}</p>
            <p className="mt-1 text-sm text-text-muted">
              Version {APP_VERSION} · Free and open source (Apache-2.0)
            </p>
          </div>
          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noreferrer"
            className={buttonClasses({
              variant: 'secondary',
              className: 'self-start sm:self-auto',
            })}
          >
            Source on GitHub
            <ExternalLink aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
        <SponsorBlockCredit />
      </SettingsSection>
    </div>
  )
}
