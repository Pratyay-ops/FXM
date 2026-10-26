import { SPONSORBLOCK_DATA_LICENSE, SPONSORBLOCK_ORIGIN } from '@fxm/sources/sponsorblock'
import { Switch } from '../queue/switch'
import { useSettingsStore } from '../settings/settings-store'
import { useSponsorBlockStore } from './sponsorblock-store'

/** SponsorBlock's site, as the attribution names it. */
const SPONSORBLOCK_SITE = `${SPONSORBLOCK_ORIGIN}/`

const LINK = 'font-semibold text-text underline underline-offset-2 hover:text-accent'

/** A link that opens in a new tab, and says so to screen readers. */
function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/**
 * The credit SponsorBlock's licence asks for, after its attribution template: "Uses SponsorBlock
 * data licensed under CC BY-NC-SA 4.0 from sponsor.ajay.app", with both links.
 */
export function SponsorBlockAttribution() {
  return (
    <>
      Uses SponsorBlock data licensed under{' '}
      <ExternalLink href={SPONSORBLOCK_DATA_LICENSE.url}>
        {SPONSORBLOCK_DATA_LICENSE.name}
      </ExternalLink>{' '}
      from <ExternalLink href={SPONSORBLOCK_SITE}>sponsor.ajay.app</ExternalLink>.
    </>
  )
}

/** What skipping does. */
const SKIP_DESCRIPTION =
  'In Music + Video, skips the intros, skits and outros that SponsorBlock’s community marks in music videos. Songs always play in full.'

/** How FXM keeps SponsorBlock from learning what plays. */
const SKIP_PRIVACY =
  'FXM asks SponsorBlock about a group of videos at a time, never about the one that plays, so SponsorBlock can’t tell what you listen to.'

/**
 * The SponsorBlock setting, for Settings → Playback: the switch, what it does and how it keeps
 * what plays private, and the data's licence. Off by default; setting it answers the offer too.
 */
export function SponsorBlockSetting() {
  const enabled = useSponsorBlockStore((state) => state.enabled)
  const setEnabled = useSponsorBlockStore((state) => state.setEnabled)
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  return (
    <div className="space-y-3 p-4 sm:p-5">
      <Switch
        label="Skip non-music parts of videos"
        description={SKIP_DESCRIPTION}
        checked={enabled}
        onChange={setEnabled}
      />
      <div className="space-y-2 text-sm text-text-muted">
        {enabled && catalogMode === 'music' && (
          <p>It starts working when you switch the catalog mode to Music + Video.</p>
        )}
        <p>{SKIP_PRIVACY}</p>
        <p>
          <SponsorBlockAttribution />
        </p>
      </div>
    </div>
  )
}

/** The SponsorBlock credit, for Settings → About. */
export function SponsorBlockCredit() {
  return (
    <div className="p-4 text-sm text-text-muted sm:p-5">
      <p className="font-semibold text-text">Non-music parts of videos</p>
      <p className="mt-1">
        <SponsorBlockAttribution />
      </p>
    </div>
  )
}
