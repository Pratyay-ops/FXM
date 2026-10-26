/**
 * The onboarding page (`/connect`): which tier this device is in and why, what it is missing and
 * the one install that gets it more, the install guides, and what each tier plays. When FXM
 * Connect is out of date, or worked here before and doesn't answer now, the page leads with what
 * to do. Below Full, the guides come before the tier cards.
 *
 * @module
 */

import { CONNECT_MARKER_ATTRIBUTE, MIN_CONNECT_VERSION } from '@fxm/platform'
import { LoaderCircle, MonitorSmartphone, PlugZap, TriangleAlert } from 'lucide-react'
import { type ReactNode, useId, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { PageTitle } from '../../components/ui/page'
import { cn } from '../../lib/cn'
import { RELEASED, RELEASES_URL } from './config'
import { useConnection } from './connection'
import {
  BROWSER_NAMES,
  type BrowserFamily,
  currentDevice,
  type DeviceInfo,
  extensionsPage,
  isChromium,
} from './device'
import {
  appsSentence,
  canGetMoreHere,
  connectionTier,
  describeConnect,
  explainConnection,
  isDetecting,
} from './explain'
import { ChromiumNotes, guideAction, InstallGuides, openGuide } from './install-guides'
import { removedOnPurpose } from './notices'
import { MissingPanel, TierCards } from './tier-overview'
import { TIER_INFO } from './tiers'
import {
  CopyableAddress,
  ExternalLink,
  panelButtonClasses,
  panelIconClasses,
  panelToneClasses,
  standaloneLinkClasses,
  TierName,
  textLinkClasses,
} from './ui'

/** The `id` of the status card, where focus goes when the section that had it goes away. */
const STATUS_ID = 'connect-status'

function Section({
  id,
  title,
  className,
  children,
}: {
  id?: string
  title: string
  className?: string
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn('scroll-mt-[calc(var(--shell-top)+1rem)] space-y-4', className)}
    >
      <h2 id={headingId} className="text-xl font-bold tracking-tight md:text-2xl">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** A panel that needs the user: FXM Connect is out of date or doesn't answer. */
function WarningPanel({ lead, children }: { lead: ReactNode; children: ReactNode }) {
  return (
    <div
      className={cn(
        'space-y-4 rounded-xl border border-l-4 p-4 sm:p-5',
        panelToneClasses('warning'),
      )}
    >
      <p className="flex gap-2.5">
        <TriangleAlert
          aria-hidden="true"
          className={cn('mt-0.5 size-5 shrink-0', panelIconClasses('warning'))}
        />
        <span>{lead}</span>
      </p>
      {children}
    </div>
  )
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="list-decimal space-y-2 pl-5 text-sm marker:font-bold marker:text-accent">
      {children}
    </ol>
  )
}

function ReleaseLink() {
  return (
    <ExternalLink href={RELEASES_URL} className={textLinkClasses}>
      GitHub
    </ExternalLink>
  )
}

/** Whether FXM Connect's marker is on the page: a guess at Full before detection is done. */
function connectMarkerPresent(): boolean {
  return document.documentElement.hasAttribute(CONNECT_MARKER_ATTRIBUTE)
}

/** This device's tier and why, what it is missing, and the install that gets it more. */
function StatusCard({ device }: { device: DeviceInfo }) {
  const state = useConnection()
  const headingId = useId()
  const detecting = isDetecting(state)
  const tier = connectionTier(state)
  const web = state.platform === 'web'
  const { connect } = state
  // The update or "isn't answering" section right below says it in full.
  const problem = connect?.state === 'outdated' || connect?.state === 'missing'
  const repeated = problem ? describeConnect(connect) : undefined
  const reasons = explainConnection(state, device).filter((line) => line !== repeated)
  const action = web && !detecting && !problem && tier !== 'full' ? guideAction(device) : undefined
  return (
    <section
      id={STATUS_ID}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="flex max-w-3xl scroll-mt-[calc(var(--shell-top)+1rem)] flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-md sm:flex-row sm:p-6"
    >
      <span className="grid size-12 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
        {detecting ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-6 animate-spin motion-reduce:animate-none"
          />
        ) : (
          <PlugZap aria-hidden="true" className="size-6" />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-4">
        <div className="space-y-2">
          <h2 id={headingId} className="text-xs font-bold tracking-[0.14em] text-accent uppercase">
            {web ? 'This browser' : 'This app'}
          </h2>
          <div aria-live="polite" className="space-y-2">
            {detecting ? (
              <p className="text-xl font-extrabold tracking-tight">Checking…</p>
            ) : (
              <>
                <p className="text-xl font-extrabold tracking-tight">
                  <TierName tier={tier} />
                </p>
                <p className="text-text-muted">{TIER_INFO[tier].summary}</p>
              </>
            )}
            <ul className="space-y-1 text-sm text-text-muted">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        </div>
        {web && !detecting && <MissingPanel tier={tier} />}
        {!detecting && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {action !== undefined && (
              <button
                type="button"
                className={buttonClasses()}
                onClick={() => openGuide(action.guide)}
              >
                {action.label}
              </button>
            )}
            <Link to="/settings#diagnostics" className={standaloneLinkClasses}>
              Diagnostics and the song self-test
            </Link>
          </div>
        )}
      </div>
    </section>
  )
}

/** The update steps for FXM Connect from the zip, in a Chromium browser. */
function ZipUpdateSteps({ browser }: { browser: BrowserFamily }) {
  return (
    <Steps>
      <li>
        Download the latest <code className="wrap-anywhere">fxm-connect-chromium-….zip</code> from{' '}
        <ReleaseLink /> and unzip it over the folder you installed FXM Connect from.
      </li>
      <li>
        Press <strong>Reload</strong> on FXM Connect's card on the browser's extensions page:{' '}
        <CopyableAddress value={extensionsPage(browser)} />
      </li>
      <li>Reload this page.</li>
    </Steps>
  )
}

/** The update steps in Firefox: the signed add-on once it is out, the temporary one until then. */
function FirefoxUpdateSteps() {
  return RELEASED.firefoxAddon ? (
    <Steps>
      <li>
        Download the latest <code className="wrap-anywhere">fxm-connect-firefox-….xpi</code> from{' '}
        <ReleaseLink />.
      </li>
      <li>
        On <CopyableAddress value="about:addons" /> click the gear button, choose{' '}
        <strong>Install Add-on From File</strong> and pick the file.
      </li>
      <li>Reload this page.</li>
    </Steps>
  ) : (
    <Steps>
      <li>
        Download the latest <code className="wrap-anywhere">fxm-connect-firefox-….zip</code> from{' '}
        <ReleaseLink />.
      </li>
      <li>
        Remove the old FXM Connect and load the new zip with <strong>Load Temporary Add-on…</strong>{' '}
        on this page: <CopyableAddress value="about:debugging#/runtime/this-firefox" />
      </li>
      <li>Reload this page.</li>
    </Steps>
  )
}

/** How to update an FXM Connect that is too old. */
function UpdateSection({ device, version }: { device: DeviceInfo; version: string | undefined }) {
  const browser: BrowserFamily = isChromium(device.browser) ? device.browser : 'chrome'
  return (
    <Section id="update" title="Update FXM Connect" className="max-w-3xl">
      <WarningPanel
        lead={
          <>
            FXM Connect{version === undefined ? '' : ` ${version}`} is too old for this version of
            FXM, so FXM doesn't use it. Install version {MIN_CONNECT_VERSION} or later:
          </>
        }
      >
        {device.browser === 'firefox' ? (
          <FirefoxUpdateSteps />
        ) : (
          <>
            {browser === 'edge' && RELEASED.edgeAddon && (
              <p className="text-sm">
                If you added FXM Connect from Edge Add-ons, Edge updates it by itself. To update it
                now, turn on <strong>Developer mode</strong> on{' '}
                <CopyableAddress value="edge://extensions" /> and choose <strong>Update</strong>. If
                you loaded the zip:
              </p>
            )}
            <ZipUpdateSteps browser={browser} />
            <ChromiumNotes />
          </>
        )}
      </WarningPanel>
    </Section>
  )
}

/** Why FXM Connect may be off, and how to turn it back on, for this browser. */
function TurnedOff({ device }: { device: DeviceInfo }) {
  if (device.browser === 'firefox') {
    return RELEASED.firefoxAddon ? (
      <li>
        <strong>It's turned off, or was removed.</strong> Turn it back on, or add it again, on
        Firefox's add-ons page: <CopyableAddress value="about:addons" />
      </li>
    ) : (
      <li>
        <strong>Firefox removed it when it restarted.</strong> Temporary add-ons last until the next
        restart. Load it again here:{' '}
        <CopyableAddress value="about:debugging#/runtime/this-firefox" />
      </li>
    )
  }
  const browser: BrowserFamily = isChromium(device.browser) ? device.browser : 'chrome'
  if (browser === 'edge' && RELEASED.edgeAddon) {
    return (
      <li>
        <strong>It's turned off.</strong> Turn it back on on the extensions page:{' '}
        <CopyableAddress value="edge://extensions" /> If you loaded the zip, turn on Developer mode
        there too: Edge turns extensions loaded from a folder off without it.
      </li>
    )
  }
  return (
    <li>
      <strong>It's turned off.</strong> {BROWSER_NAMES[browser]} also turns it off whenever
      Developer mode is off. Turn both back on on the extensions page:{' '}
      <CopyableAddress value={extensionsPage(browser)} />
    </li>
  )
}

/** What to do when FXM Connect worked here before and doesn't answer now. */
function MissingSection({ device, version }: { device: DeviceInfo; version: string | undefined }) {
  const firefox = device.browser === 'firefox'
  return (
    <Section id="missing" title="FXM Connect isn't answering" className="max-w-3xl">
      <WarningPanel
        lead={
          <>
            FXM Connect worked in this browser before
            {version === undefined ? '' : ` (version ${version})`}, but it isn't answering now.
          </>
        }
      >
        <ul className="list-disc space-y-2 pl-5 text-sm">
          <TurnedOff device={device} />
          <li>
            <strong>The browser blocked or removed it.</strong> Browsers managed by an employer or a
            school can block extensions
            {firefox ? ', and Mozilla can block an add-on for everyone' : ''}.
          </li>
        </ul>
        <p className="text-sm">{appsSentence()}</p>
        <div className="flex flex-wrap gap-3">
          {RELEASED.desktop && (
            <button
              type="button"
              className={panelButtonClasses}
              onClick={() => openGuide('desktop')}
            >
              Desktop app
            </button>
          )}
          {RELEASED.android && (
            <button
              type="button"
              className={panelButtonClasses}
              onClick={() => openGuide('android')}
            >
              Android app
            </button>
          )}
          <button
            type="button"
            className={buttonClasses({ variant: 'ghost' })}
            onClick={() => {
              // This section goes away: focus the status card, which then says what changed.
              document.getElementById(STATUS_ID)?.focus()
              removedOnPurpose()
            }}
          >
            I removed it on purpose
          </button>
        </div>
      </WarningPanel>
    </Section>
  )
}

export function ConnectPage() {
  const state = useConnection()
  const device = useMemo(currentDevice, [])
  const tier = connectionTier(state)
  const detecting = isDetecting(state)
  const web = state.platform === 'web'
  const { connect } = state
  // Before detection is done, FXM Connect's marker is the best guess at Full. Whether the first
  // guide starts open is decided once, so it never opens or closes under the reader.
  const [markerPresent] = useState(() => web && connectMarkerPresent())
  const full = detecting ? markerPresent : tier === 'full'
  const [openFirst] = useState(!full)
  const guidesFirst = !full && connect?.state !== 'outdated'

  const install = web && (
    <Section
      id="install"
      title={
        full
          ? 'Other browsers and apps'
          : canGetMoreHere(device)
            ? 'Get everything'
            : 'Other devices and apps'
      }
      className="max-w-3xl"
    >
      <p className="flex gap-2.5 text-text-muted">
        <MonitorSmartphone aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <span>
          FXM Connect is a small, free extension that lets this web app reach YouTube Music and
          Spotify from your own browser. It adjusts a few headers on FXM's own requests and removes
          your cookies from them, and it fetches Spotify's public server time when the web app asks.
          Its option to use your Spotify login is off unless you turn it on. {appsSentence()}
        </span>
      </p>
      <InstallGuides device={device} openFirst={openFirst} />
    </Section>
  )

  return (
    <div className="max-w-5xl space-y-10 pt-2 md:pt-4">
      <div className="max-w-3xl space-y-2">
        <PageTitle hideOnPhone>FXM Connect</PageTitle>
        <p className="text-text-muted">
          How FXM reaches music on this device, what each tier plays, and how to get more.
        </p>
      </div>

      <StatusCard device={device} />

      {connect?.state === 'outdated' && <UpdateSection device={device} version={connect.version} />}
      {connect?.state === 'missing' && (
        <MissingSection device={device} version={connect.lastSeenVersion} />
      )}

      {guidesFirst && install}

      <Section id="tiers" title="What works where">
        <TierCards
          current={detecting ? undefined : tier}
          here={web ? 'This browser' : 'This app'}
        />
      </Section>

      {!guidesFirst && install}
    </div>
  )
}
