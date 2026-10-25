import { APP_NAME, APP_TAGLINE, APP_VERSION } from '@fxm/core'
import { ExternalLink } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { LogoMark } from '../../components/ui/logo'
import { PageTitle } from '../../components/ui/page'
import { SegmentedControl } from '../../components/ui/segmented-control'
import { DiagnosticsSection } from '../connect/diagnostics'
import { CatalogModeControl } from './catalog-mode-control'
import { CATALOG_MODE_DESCRIPTIONS, THEME_OPTIONS } from './options'
import { useSettingsStore } from './settings-store'

export const REPOSITORY_URL = 'https://github.com/Pratyay-ops/FXM'

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="px-1 text-lg font-bold tracking-tight">
        {title}
      </h2>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface">
        {children}
      </div>
    </section>
  )
}

/**
 * One setting: a label with optional help beside its control. Phones stack them as
 * label, control, help, so help whose length changes with the value (catalog mode)
 * never moves the control under the user's finger.
 */
function SettingRow({
  label,
  labelId,
  help,
  children,
}: {
  label: string
  labelId: string
  help?: ReactNode
  children: ReactNode
}) {
  return (
    // From 768px: label and help (up to 20rem, narrower if needed) left, the whole control right.
    <div className="grid gap-3 p-4 sm:p-5 md:grid-cols-[minmax(0,20rem)_max-content] md:grid-rows-[auto_1fr] md:justify-between md:gap-x-8 md:gap-y-1">
      <p id={labelId} className="font-semibold md:col-start-1 md:row-start-1">
        {label}
      </p>
      <div className="min-w-0 md:col-start-2 md:row-span-2 md:row-start-1">{children}</div>
      {help && <div className="md:col-start-1 md:row-start-2">{help}</div>}
    </div>
  )
}

export function SettingsPage() {
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const theme = useSettingsStore((state) => state.theme)
  const setTheme = useSettingsStore((state) => state.setTheme)
  const modeLabelId = useId()
  const modeHelpId = useId()
  const themeLabelId = useId()

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
      </SettingsSection>

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
      </SettingsSection>
    </div>
  )
}
