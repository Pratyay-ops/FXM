/**
 * The onboarding page (`/connect`): which tier this device is in and why, what each tier plays,
 * what this one is missing, and the install guides for FXM Connect and the apps. When FXM Connect
 * is out of date, or worked here before and doesn't answer now, the page leads with what to do.
 *
 * @module
 */

import { MIN_CONNECT_VERSION } from '@fxm/platform'
import { LoaderCircle, MonitorSmartphone, PlugZap, TriangleAlert } from 'lucide-react'
import { type ReactNode, useId, useMemo } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { PageTitle } from '../../components/ui/page'
import { RELEASES_URL } from './config'
import { forgetConnect, useConnection } from './connection'
import { BROWSER_NAMES, currentDevice, type DeviceInfo, extensionsPage, isChromium } from './device'
import { connectionTier, explainConnection, isDetecting } from './explain'
import { ChromiumNotes, InstallGuides, openGuide } from './install-guides'
import { MissingPanel, TierCards } from './tier-overview'
import { TIER_INFO } from './tiers'
import { CopyableAddress, ExternalLink, TierName, textLinkClasses } from './ui'

function Section({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  const headingId = useId()
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="scroll-mt-[calc(var(--shell-top)+1rem)] space-y-4"
    >
      <h2 id={headingId} className="text-xl font-bold tracking-tight md:text-2xl">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** This device's tier and why, or the check while it runs. */
function StatusCard({ here }: { here: string }) {
  const state = useConnection()
  const detecting = isDetecting(state)
  const tier = connectionTier(state)
  const reasons = explainConnection(state)
  return (
    <div
      role="status"
      className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-md sm:flex-row sm:p-6"
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
      <div className="min-w-0 space-y-2">
        <p className="text-xs font-bold tracking-[0.14em] text-accent uppercase">{here}</p>
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
        {!detecting && (
          <p className="pt-1 text-sm">
            <Link to="/settings#diagnostics" className={textLinkClasses}>
              Diagnostics and the song self-test
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}

/** How to update an FXM Connect that is too old. */
function UpdateSection({ device, version }: { device: DeviceInfo; version: string | undefined }) {
  const firefox = device.browser === 'firefox'
  return (
    <Section id="update" title="Update FXM Connect">
      <div className="space-y-4 rounded-xl border border-accent/40 bg-accent/8 p-4 sm:p-5">
        <p className="flex gap-2.5">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" />
          <span>
            FXM Connect{version === undefined ? '' : ` ${version}`} is too old for this version of
            FXM, so FXM doesn't use it. Install version {MIN_CONNECT_VERSION} or later:
          </span>
        </p>
        {firefox ? (
          <ol className="list-decimal space-y-2 pl-5 text-sm marker:font-bold marker:text-accent">
            <li>
              Download the latest <code className="wrap-anywhere">fxm-connect-firefox-….zip</code>{' '}
              from{' '}
              <ExternalLink href={RELEASES_URL} className={textLinkClasses}>
                GitHub
              </ExternalLink>
              .
            </li>
            <li>
              Remove the old FXM Connect and load the new zip with{' '}
              <strong>Load Temporary Add-on…</strong> on this page:{' '}
              <CopyableAddress value="about:debugging#/runtime/this-firefox" />
            </li>
            <li>Reload this page.</li>
          </ol>
        ) : (
          <>
            <ol className="list-decimal space-y-2 pl-5 text-sm marker:font-bold marker:text-accent">
              <li>
                Download the latest{' '}
                <code className="wrap-anywhere">fxm-connect-chromium-….zip</code> from{' '}
                <ExternalLink href={RELEASES_URL} className={textLinkClasses}>
                  GitHub
                </ExternalLink>{' '}
                and unzip it over the folder you installed FXM Connect from.
              </li>
              <li>
                Press <strong>Reload</strong> on FXM Connect's card on the browser's extensions
                page:{' '}
                <CopyableAddress
                  value={extensionsPage(isChromium(device.browser) ? device.browser : 'chrome')}
                />
              </li>
              <li>Reload this page.</li>
            </ol>
            <ChromiumNotes />
          </>
        )}
      </div>
    </Section>
  )
}

/** What to do when FXM Connect worked here before and doesn't answer now. */
function MissingSection({ device, version }: { device: DeviceInfo; version: string | undefined }) {
  const firefox = device.browser === 'firefox'
  const browser = isChromium(device.browser) ? device.browser : 'chrome'
  return (
    <Section id="missing" title="FXM Connect isn't answering">
      <div className="space-y-4 rounded-xl border border-accent/40 bg-accent/8 p-4 sm:p-5">
        <p className="flex gap-2.5">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" />
          <span>
            FXM Connect worked in this browser before
            {version === undefined ? '' : ` (version ${version})`}, but it isn't answering now.
          </span>
        </p>
        <ul className="list-disc space-y-2 pl-5 text-sm">
          {firefox ? (
            <li>
              <strong>Firefox removed it when it restarted.</strong> Temporary add-ons last until
              the next restart. Load it again here:{' '}
              <CopyableAddress value="about:debugging#/runtime/this-firefox" />
            </li>
          ) : (
            <li>
              <strong>It's turned off.</strong> {BROWSER_NAMES[browser]} also turns it off whenever
              Developer mode is off. Turn both back on on the extensions page:{' '}
              <CopyableAddress value={extensionsPage(browser)} />
            </li>
          )}
          <li>
            <strong>The browser blocked or removed it.</strong> Browsers managed by an employer or a
            school can block extensions
            {firefox ? ', and Mozilla can block an add-on for everyone' : ''}.
          </li>
        </ul>
        <p className="text-sm">
          Rather not depend on an extension? The desktop app and the Android app have everything
          built in.
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={buttonClasses({ variant: 'secondary' })}
            onClick={() => openGuide('desktop')}
          >
            Desktop app
          </button>
          <button
            type="button"
            className={buttonClasses({ variant: 'secondary' })}
            onClick={() => openGuide('android')}
          >
            Android app
          </button>
          <button
            type="button"
            className={buttonClasses({ variant: 'ghost' })}
            onClick={forgetConnect}
          >
            I removed it on purpose
          </button>
        </div>
      </div>
    </Section>
  )
}

export function ConnectPage() {
  const state = useConnection()
  const device = useMemo(currentDevice, [])
  const tier = connectionTier(state)
  const detecting = isDetecting(state)
  const web = state.platform === 'web'
  const here = web ? 'This browser' : 'This app'
  const { connect } = state

  return (
    <div className="max-w-5xl space-y-10 pt-2 md:pt-4">
      <div className="space-y-2">
        <PageTitle hideOnPhone>FXM Connect</PageTitle>
        <p className="max-w-2xl text-text-muted">
          How FXM reaches music on this device, what each way of using it plays, and how to get
          everything.
        </p>
      </div>

      <StatusCard here={here} />

      {connect?.state === 'outdated' && <UpdateSection device={device} version={connect.version} />}
      {connect?.state === 'missing' && (
        <MissingSection device={device} version={connect.lastSeenVersion} />
      )}

      <Section id="tiers" title="What works where">
        <TierCards current={detecting ? undefined : tier} here={here} />
        {!detecting && <MissingPanel tier={tier} lite={state.lite} />}
      </Section>

      {web && (
        <Section
          id="install"
          title={tier === 'full' ? 'Other browsers and apps' : 'Get everything'}
        >
          <p className="flex max-w-3xl gap-2.5 text-text-muted">
            <MonitorSmartphone aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <span>
              FXM Connect is a small, free extension that lets this web app reach YouTube Music and
              Spotify from your own browser. It adjusts a few headers on FXM's own requests and
              removes your cookies from them. Its only other part, an option to use your Spotify
              login, is off unless you turn it on. The desktop and Android apps need no extension.
            </span>
          </p>
          <InstallGuides device={device} openFirst={!detecting && tier !== 'full'} />
        </Section>
      )}
    </div>
  )
}
