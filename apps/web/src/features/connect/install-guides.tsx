/**
 * The install guides: FXM Connect for Chromium browsers (the unpacked zip), Edge and Firefox,
 * the desktop app, the Android app, and what Safari, iPhone and iPad get. Each guide is a
 * disclosure; the one that fits the device comes first and starts open. An app that isn't
 * released yet (`RELEASED`) gets no steps, only where to follow its release.
 *
 * The steps follow `apps/extension/README.md` ("Install") and docs/ARCHITECTURE.md §3 and §16.
 *
 * @module
 */

import { CircleAlert, Info, RefreshCw, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import { freeSources } from '../../lib/free-sources'
import { DESKTOP_INSTALL_URL, RELEASED, RELEASES_URL } from './config'
import {
  BROWSER_NAMES,
  type BrowserFamily,
  type DeviceInfo,
  extensionsPage,
  type GuideId,
  isChromium,
  isMacSafari,
  recommendedGuide,
} from './device'
import { Chip, ComingSoonChip, CopyableAddress, ExternalLink, textLinkClasses } from './ui'

/** The guides in their usual order. */
export const GUIDE_ORDER: readonly GuideId[] = [
  'chromium',
  'firefox',
  'desktop',
  'android',
  'apple',
]

/** The guides for a device: the recommended one first. */
export function orderedGuides(device: DeviceInfo): GuideId[] {
  const first = recommendedGuide(device)
  return [first, ...GUIDE_ORDER.filter((guide) => guide !== first)]
}

/** The `id` of a guide's disclosure, for links that open it. */
export function guideElementId(guide: GuideId): string {
  return `guide-${guide}`
}

/** Opens a guide's disclosure and scrolls to it. */
export function openGuide(guide: GuideId): void {
  const element = document.getElementById(guideElementId(guide))
  if (!(element instanceof HTMLDetailsElement)) return
  element.open = true
  element.scrollIntoView({ block: 'start' })
  element.querySelector('summary')?.focus()
}

/**
 * The install this device can do now, as the onboarding page's main button: FXM Connect in its
 * browser, or an app once it is out. Nothing for Safari, iPhone and iPad, and nothing for an app
 * that isn't released.
 */
export function guideAction(device: DeviceInfo): { guide: GuideId; label: string } | undefined {
  const guide = recommendedGuide(device)
  switch (guide) {
    case 'chromium':
      return {
        guide,
        label: isChromium(device.browser)
          ? `Add FXM Connect to ${BROWSER_NAMES[device.browser]}`
          : 'Get FXM Connect',
      }
    case 'firefox':
      return { guide, label: 'Add FXM Connect to Firefox' }
    case 'desktop':
      return RELEASED.desktop ? { guide, label: 'Get the desktop app' } : undefined
    case 'android':
      return RELEASED.android ? { guide, label: 'Get the Android app' } : undefined
    case 'apple':
      return undefined
  }
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="list-decimal space-y-2 pl-5 text-sm marker:font-bold marker:text-accent">
      {children}
    </ol>
  )
}

function Notes({ children }: { children: ReactNode }) {
  return <ul className="space-y-2 text-sm text-text-muted">{children}</ul>
}

function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-2.5 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
      {icon}
      <span>{children}</span>
    </li>
  )
}

function ReleaseLink({ children }: { children: ReactNode }) {
  return (
    <ExternalLink href={RELEASES_URL} className={textLinkClasses}>
      {children}
    </ExternalLink>
  )
}

/** In place of the steps of an app that isn't out yet. */
function NotReleased() {
  return (
    <p className="text-sm">
      Not released yet: <ReleaseLink>follow the releases on GitHub</ReleaseLink>.
    </p>
  )
}

/** The Chromium steps, with the extensions page of `browser`. */
export function ChromiumSteps({ browser }: { browser: BrowserFamily }) {
  return (
    <Steps>
      <li>
        Download <code className="wrap-anywhere">fxm-connect-chromium-….zip</code> from the{' '}
        <ReleaseLink>latest release on GitHub</ReleaseLink> and unzip it into a folder you'll keep:
        the browser loads FXM Connect from there.
      </li>
      <li>
        Pages can't link to the browser's extensions page, so copy its address into the address bar
        of a new tab: <CopyableAddress value={extensionsPage(browser)} />
      </li>
      <li>
        Turn on <strong>Developer mode</strong>, choose <strong>Load unpacked</strong> and pick the
        unzipped folder.
      </li>
      <li>Come back to FXM and reload the page.</li>
    </Steps>
  )
}

/** What to know about the unpacked zip: Developer mode, manual updates, managed browsers. */
export function ChromiumNotes() {
  return (
    <Notes>
      <Note icon={<CircleAlert aria-hidden="true" />}>
        <strong className="text-text">Leave Developer mode on.</strong> Since version 134, Chrome
        turns FXM Connect off whenever Developer mode is off.
      </Note>
      <Note icon={<RefreshCw aria-hidden="true" />}>
        <strong className="text-text">Updates are manual.</strong> When FXM says FXM Connect is out
        of date, unzip the new release over the same folder and press <strong>Reload</strong> on its
        card.
      </Note>
      <Note icon={<Wrench aria-hidden="true" />}>
        Browsers managed by an employer or a school may block extensions installed this way.
      </Note>
    </Notes>
  )
}

/** The Firefox steps: the temporary add-on until Mozilla signs FXM Connect (stage R.2). */
export function FirefoxSteps() {
  if (RELEASED.firefoxAddon) {
    return (
      <Steps>
        <li>
          Download <code className="wrap-anywhere">fxm-connect-firefox-….xpi</code>, the add-on
          signed by Mozilla, from the <ReleaseLink>latest release on GitHub</ReleaseLink>.
        </li>
        <li>
          Copy this address into the address bar of a new tab:{' '}
          <CopyableAddress value="about:addons" />
        </li>
        <li>
          Click the gear button, choose <strong>Install Add-on From File</strong> and pick the file.
        </li>
        <li>Come back to FXM and reload the page.</li>
      </Steps>
    )
  }
  return (
    <Steps>
      <li>
        Download <code className="wrap-anywhere">fxm-connect-firefox-….zip</code> from the{' '}
        <ReleaseLink>latest release on GitHub</ReleaseLink>.
      </li>
      <li>
        Copy this address into the address bar of a new tab:{' '}
        <CopyableAddress value="about:debugging#/runtime/this-firefox" />
      </li>
      <li>
        Choose <strong>Load Temporary Add-on…</strong> and pick the zip.
      </li>
      <li>Come back to FXM and reload the page.</li>
    </Steps>
  )
}

function FirefoxNotes() {
  return (
    <Notes>
      {!RELEASED.firefoxAddon && (
        <Note icon={<RefreshCw aria-hidden="true" />}>
          <strong className="text-text">Firefox removes temporary add-ons when it restarts.</strong>{' '}
          Load it again after each restart, until the add-on signed by Mozilla is out.
        </Note>
      )}
      <Note icon={<Info aria-hidden="true" />}>
        If FXM doesn't find it, allow FXM Connect access to the listed sites under{' '}
        <strong>Permissions</strong> on its page in <CopyableAddress value="about:addons" />
      </Note>
    </Notes>
  )
}

interface GuideProps {
  readonly id: GuideId
  readonly title: string
  readonly chips?: ReactNode
  readonly open: boolean
  readonly children: ReactNode
}

function Guide({ id, title, chips, open, children }: GuideProps) {
  return (
    <details
      id={guideElementId(id)}
      open={open}
      className="group scroll-mt-[calc(var(--shell-top)+1rem)] rounded-xl border border-border bg-surface open:border-border-strong"
    >
      {/* Two columns, so the chevron keeps its place however the title and its chips wrap. */}
      <summary className="grid min-h-touch cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl px-4 py-3 marker:content-none sm:px-5 [&::-webkit-details-marker]:hidden">
        <h3 className="flex flex-wrap items-center gap-x-3 gap-y-1 font-bold">
          <span>{title}</span>
          {chips}
        </h3>
        <span
          aria-hidden="true"
          className="mr-1 size-2.5 rotate-45 border-r-2 border-b-2 border-text-muted transition-transform group-open:-rotate-135"
        />
      </summary>
      <div className="space-y-4 border-t border-border px-4 pt-4 pb-5 sm:px-5">{children}</div>
    </details>
  )
}

/** Options for {@link InstallGuides}. */
export interface InstallGuidesProps {
  /** The visitor's device, which picks the first guide. */
  readonly device: DeviceInfo
  /**
   * Whether the first guide starts open: off when FXM already has full access. Read when the
   * guides first render only, so a guide never opens or closes under the reader later.
   */
  readonly openFirst: boolean
}

/** Every install guide, the one for this device first. */
export function InstallGuides({ device, openFirst }: InstallGuidesProps) {
  const guides = orderedGuides(device)
  const browser: BrowserFamily = isChromium(device.browser) ? device.browser : 'chrome'
  const forThis = <Chip tone="accent">For this device</Chip>

  const render = (guide: GuideId, index: number) => {
    const open = openFirst && index === 0
    const chips = index === 0 ? forThis : undefined
    switch (guide) {
      case 'chromium':
        return (
          <Guide
            key={guide}
            id={guide}
            title="Chrome, Edge, Brave and other Chromium browsers"
            chips={chips}
            open={open}
          >
            <p className="text-sm text-text-muted">
              For Chromium browsers version 120 or later, on a computer. FXM Connect isn't in the
              Chrome Web Store, so it installs from a zip.
              {RELEASED.edgeAddon
                ? ' In Edge you can get it from Edge Add-ons instead.'
                : " It isn't on Edge Add-ons yet either: in Edge, use these steps too."}
            </p>
            <ChromiumSteps browser={browser} />
            <ChromiumNotes />
          </Guide>
        )
      case 'firefox':
        return (
          <Guide key={guide} id={guide} title="Firefox" chips={chips} open={open}>
            <p className="text-sm text-text-muted">
              {RELEASED.firefoxAddon
                ? 'For Firefox 140 or later.'
                : 'For Firefox 140 or later, on a computer. Until Mozilla signs FXM Connect, Firefox loads it as a temporary add-on.'}
            </p>
            <FirefoxSteps />
            <FirefoxNotes />
          </Guide>
        )
      case 'desktop':
        return (
          <Guide
            key={guide}
            id={guide}
            title="Desktop app"
            chips={
              <>
                {chips}
                {!RELEASED.desktop && <ComingSoonChip />}
              </>
            }
            open={open}
          >
            <p className="text-sm text-text-muted">
              For macOS, Windows and Linux, with everything built in: no extension needed.
            </p>
            {RELEASED.desktop ? (
              <>
                <Steps>
                  <li>
                    Download the installer for your computer from the{' '}
                    <ReleaseLink>latest release on GitHub</ReleaseLink>: the <code>.dmg</code> for
                    macOS (<code>macos-arm64</code> for Apple silicon, <code>macos-x64</code> for
                    Intel), the <code>-setup.exe</code> for Windows, the <code>.deb</code> or the
                    AppImage for Linux.
                  </li>
                  <li>
                    On macOS, the first time you open it, go to System Settings → Privacy &amp;
                    Security and choose <strong>Open Anyway</strong>: the app isn't notarized by
                    Apple.
                  </li>
                  <li>
                    On Windows, if SmartScreen warns about an unrecognized app, choose{' '}
                    <strong>More info</strong>, then <strong>Run anyway</strong>. Smart App Control
                    blocks it outright, as the installer isn't signed.
                  </li>
                </Steps>
                <p className="text-sm">
                  The{' '}
                  <ExternalLink href={DESKTOP_INSTALL_URL} className={textLinkClasses}>
                    install steps
                  </ExternalLink>{' '}
                  have the details, Smart App Control and Linux's packages included. The app looks
                  for updates and asks before it installs one.
                </p>
              </>
            ) : (
              <NotReleased />
            )}
          </Guide>
        )
      case 'android':
        return (
          <Guide
            key={guide}
            id={guide}
            title="Android app"
            chips={
              <>
                {chips}
                {!RELEASED.android && <ComingSoonChip />}
              </>
            }
            open={open}
          >
            <p className="text-sm text-text-muted">
              Chrome on Android can't add extensions.{' '}
              {RELEASED.android
                ? 'The Android app has everything built in instead.'
                : 'The Android app will have everything built in instead.'}
            </p>
            {!RELEASED.android && device.os === 'android' && (
              <p className="text-sm">
                Until it's out, this browser plays free music from {freeSources().and} and, where
                its check passes, YouTube Music in the experimental Lite tier.
              </p>
            )}
            {RELEASED.android ? (
              <Steps>
                <li>
                  On your phone, download the APK from the{' '}
                  <ReleaseLink>latest release on GitHub</ReleaseLink>.
                </li>
                <li>Open it. If Android asks, allow your browser to install apps.</li>
                <li>Open FXM from your apps.</li>
              </Steps>
            ) : (
              <NotReleased />
            )}
          </Guide>
        )
      case 'apple':
        return (
          <Guide key={guide} id={guide} title="Safari, iPhone and iPad" chips={chips} open={open}>
            <p className="text-sm text-text-muted">
              FXM Connect isn't available for Safari, iPhone or iPad, and there is no iPhone app.
              There, FXM plays free music from {freeSources().and} and, where its check passes,
              YouTube Music in the experimental Lite tier. Lite hasn't been tested in Safari yet.
            </p>
            {isMacSafari(device) && (
              <p className="text-sm">
                On this Mac, open FXM in Chrome, Edge, Brave or Firefox and add FXM Connect there:
                the guides for those browsers are below.
                {RELEASED.desktop ? ' Or get the desktop app.' : ''}
              </p>
            )}
          </Guide>
        )
    }
  }

  return <div className="max-w-3xl space-y-3">{guides.map(render)}</div>
}
