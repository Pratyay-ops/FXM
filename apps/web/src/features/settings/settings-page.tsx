import { APP_NAME, APP_TAGLINE, APP_VERSION } from '@fxm/core'
import { ExternalLink } from 'lucide-react'
import { useId } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { LogoMark } from '../../components/ui/logo'
import { PageTitle } from '../../components/ui/page'
import { SegmentedControl } from '../../components/ui/segmented-control'
import { DiagnosticsSection } from '../connect/diagnostics'
import { ConnectSettingsEntry } from '../connect/settings-entry'
import { ExternalLink as ExternalTextLink, standaloneLinkClasses } from '../connect/ui'
import { InstallAction, InstallHelp } from '../pwa/install-setting'
import { isInstallableWebApp } from '../pwa/web-app'
import { ScrobblingSettings } from '../scrobble/scrobbling-settings'
import { useSourcesSnapshot } from '../search/sources-context'
import { SpotifySwitchControl, SpotifySwitchHelp } from '../search/spotify-setting'
import { SponsorBlockCredit, SponsorBlockSetting } from '../sponsorblock/sponsorblock-setting'
import { SpotifyAccountSettings } from '../spotify-account/spotify-account-settings'
import { SyncSettings } from '../sync/sync-settings'
import { CatalogModeControl } from './catalog-mode-control'
import { AutoMatchSetting } from './matching-setting'
import { CATALOG_MODE_DESCRIPTIONS, THEME_OPTIONS } from './options'
import { QualitySection } from './quality-section'
import { SettingRow, SettingsSection } from './settings-layout'
import { useSettingsStore } from './settings-store'

export const REPOSITORY_URL = 'https://github.com/Pratyay-ops/FXM'

/** FXM's site, where its privacy page, disclaimer and the bundled code's notices are. */
export const SITE_URL = 'https://fxmusic.pages.dev'

/** The legal pages Settings → About links to. */
export const LEGAL_LINKS = [
  { href: `${SITE_URL}/privacy`, label: 'Privacy' },
  { href: `${SITE_URL}/disclaimer`, label: 'Disclaimer' },
  { href: `${SITE_URL}/third-party-notices.txt`, label: 'Third-party notices' },
] as const

/** The non-affiliation notice (R.4), in one line. */
export const NON_AFFILIATION =
  'FXM is an independent open-source project, not affiliated with or endorsed by YouTube, Google or Spotify, and it hosts no music.'

export function SettingsPage() {
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const theme = useSettingsStore((state) => state.theme)
  const setTheme = useSettingsStore((state) => state.setTheme)
  // What the platform reaches (stage 2.9 wires it in), so the quality help fits the tier.
  const { capabilities } = useSourcesSnapshot()
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
        <AutoMatchSetting />
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

      <SpotifyAccountSettings />

      <QualitySection capabilities={capabilities} />

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

      <ScrobblingSettings />

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

      <ConnectSettingsEntry />

      <DiagnosticsSection />

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
        <div className="space-y-2 p-4 text-sm text-text-muted sm:p-5">
          <p>{NON_AFFILIATION}</p>
          {/* Links on their own: a full touch target each on phones and tablets. */}
          <ul aria-label="Legal" className="flex flex-wrap gap-x-6">
            {LEGAL_LINKS.map((link) => (
              <li key={link.href}>
                <ExternalTextLink href={link.href} className={standaloneLinkClasses}>
                  {link.label}
                </ExternalTextLink>
              </li>
            ))}
          </ul>
        </div>
        <SponsorBlockCredit />
      </SettingsSection>
    </div>
  )
}
