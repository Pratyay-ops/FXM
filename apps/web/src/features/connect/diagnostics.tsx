/**
 * Settings → Diagnostics: the current tier and why, the details behind it (FXM Connect, the Lite
 * self-test, what YouTube and Spotify allow, the request budget), a re-check, and the "resolve
 * and play one song" self-test (docs/ARCHITECTURE.md §10).
 *
 * @module
 */

import { isFxmError } from '@fxm/core'
import { type BudgetSnapshot, type ConnectStatus, MIN_CONNECT_VERSION } from '@fxm/platform'
import { CircleCheck, CircleX, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import {
  type ConnectionState,
  connectionContext,
  type LiteStatus,
  recheckConnection,
  useConnection,
} from './connection'
import {
  connectionTier,
  describeSpotify,
  describeYouTube,
  explainConnection,
  isDetecting,
} from './explain'
import { createPlaybackProbe, type ProbeFailure, type ProbeResult } from './playback-probe'
import { getSongResolver, SELF_TEST_SONG, unavailableResolver } from './resolver'
import {
  runSongSelfTest,
  type SelfTestAttempt,
  type SelfTestReport,
  type SelfTestStep,
} from './self-test'
import { TIER_INFO } from './tiers'
import { standaloneLinkClasses, TierName } from './ui'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 p-4 sm:p-5 md:grid-cols-[10rem_minmax(0,1fr)] md:gap-x-8">
      <p className="font-semibold">{label}</p>
      <div className="min-w-0 space-y-2">{children}</div>
    </div>
  )
}

/** FXM Connect's state, in a few words. */
export function connectSummary(status: ConnectStatus | undefined, platform: string): string {
  if (platform !== 'web') return 'Not needed in the app'
  switch (status?.state) {
    case undefined:
      return 'Not checked yet'
    case 'present':
      return `Version ${status.version ?? '?'}, on`
    case 'outdated':
      return `Version ${status.version ?? '?'}, too old: FXM needs ${MIN_CONNECT_VERSION} or later`
    case 'missing':
      return status.lastSeenVersion === undefined
        ? 'Not answering, though it worked here before'
        : `Not answering, though version ${status.lastSeenVersion} worked here before`
    case 'absent':
      return 'Not installed'
  }
}

/** Lite's state, in a few words. */
export function liteSummary(lite: LiteStatus, platform: string): string {
  switch (lite) {
    case 'not-needed':
      return platform === 'web'
        ? 'Not needed: FXM Connect gives full access'
        : 'Not needed in the app'
    case 'unavailable':
      return 'Not available here'
    case 'switched-off':
      return 'Switched off for everyone at the moment'
    case 'checking':
      return 'Checking…'
    case 'passed':
      return 'Check passed'
    case 'failed':
      return "Check didn't pass in this browser"
  }
}

/** The request budget, in a sentence. */
export function budgetSummary(budget: BudgetSnapshot | undefined, now = Date.now()): string {
  if (budget === undefined) return 'Not started yet'
  const used = `${budget.used} of ${budget.hourlyLimit} in the last hour`
  if (budget.bulkPausedUntil === undefined || budget.bulkPausedUntil <= now) return used
  const until = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(
    budget.bulkPausedUntil,
  )
  return `${used}. After a bot check, background work such as imports waits until ${until}; playback goes on.`
}

function DetailList({ state }: { state: ConnectionState }) {
  const items: [string, string][] = [
    ['FXM Connect', connectSummary(state.connect, state.platform)],
    ['Lite self-test', liteSummary(state.lite, state.platform)],
    ['YouTube', describeYouTube(state.capabilities)],
    ['Spotify', describeSpotify(state.capabilities)],
    ['YouTube requests', budgetSummary(state.budget)],
  ]
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
      {items.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-text-muted">{term}</dt>
          <dd className="max-sm:mb-1">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

const PROBE_FAILURES: Readonly<Record<ProbeFailure, string>> = {
  'media-error': "the browser couldn't play it",
  stalled: 'it stalled',
  timeout: "it didn't start in time",
  blocked: 'the browser blocked playback; allow sound for this site and try again',
  aborted: 'stopped',
}

function failureText(result: Exclude<ProbeResult, { ok: true }>): string {
  const text = PROBE_FAILURES[result.reason]
  return result.detail === undefined ? text : `${text} (${result.detail})`
}

/** Why the resolution failed, from the resolver's `FxmError`. */
export function resolveErrorText(error: unknown): string {
  if (!isFxmError(error)) return "The song couldn't be resolved."
  switch (error.code) {
    case 'BotCheck':
      return "YouTube asked to confirm you're not a bot, and refused. Try again later."
    case 'RateLimited':
      return 'Too many YouTube requests for now. Try again in a few minutes.'
    case 'Network':
      return "The request didn't get through. Check your connection and try again."
    case 'Unavailable':
    case 'GeoBlocked':
    case 'NotFound':
      return "The test song isn't available here."
    case 'Unsupported':
      return "FXM can't reach YouTube Music for this request here."
    default:
      return "The song couldn't be resolved."
  }
}

function AttemptList({ attempts }: { attempts: readonly SelfTestAttempt[] }) {
  const failed = attempts.filter(
    (attempt): attempt is SelfTestAttempt & { result: Exclude<ProbeResult, { ok: true }> } =>
      !attempt.result.ok,
  )
  if (failed.length === 0) return null
  return (
    <ul className="space-y-1 text-sm text-text-muted">
      {failed.map((attempt) => (
        <li key={attempt.option.url}>
          {attempt.label}: {failureText(attempt.result)}.
        </li>
      ))}
    </ul>
  )
}

function Report({ report }: { report: SelfTestReport }) {
  switch (report.status) {
    case 'passed':
      return (
        <div className="space-y-1">
          <p className="flex gap-2 font-semibold">
            <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" />
            <span>
              Played {seconds(report.played.result.ok ? report.played.result.playedMs : 0)} of{' '}
              {report.played.label}.
            </span>
          </p>
          <p className="text-sm text-text-muted">
            Resolving took {seconds(report.resolveMs)}, and playback started{' '}
            {seconds(report.played.result.ok ? report.played.result.startedAfterMs : 0)} later.
            {report.attempts.length > 1 ? ' Before that:' : ''}
          </p>
          <AttemptList attempts={report.attempts} />
        </div>
      )
    case 'failed':
      return (
        <div className="space-y-1">
          <p className="flex gap-2 font-semibold">
            <CircleX aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
            <span>
              {report.stage === 'resolve'
                ? resolveErrorText(report.error)
                : report.stage === 'none'
                  ? 'The resolver found no stream this browser can play.'
                  : 'No stream played.'}
            </span>
          </p>
          <AttemptList attempts={report.attempts} />
        </div>
      )
    case 'skipped':
      return (
        <p className="text-sm text-text-muted">
          This device can't reach YouTube Music, so there is nothing to test.
        </p>
      )
    case 'cancelled':
      return <p className="text-sm text-text-muted">Stopped.</p>
  }
}

function stepText(step: SelfTestStep | undefined): string {
  if (step === undefined) return 'Starting…'
  return step.kind === 'resolving'
    ? step.rungs === 'fallback'
      ? 'Resolving the last-resort stream…'
      : 'Resolving the song…'
    : `Playing ${step.label}…`
}

/** The "resolve and play one song" self-test. */
function SongSelfTest({ state }: { state: ConnectionState }) {
  const [running, setRunning] = useState(false)
  const [step, setStep] = useState<SelfTestStep>()
  const [report, setReport] = useState<SelfTestReport>()
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => controller.current?.abort(), [])

  const resolver = getSongResolver()
  const tier = connectionTier(state)
  const ready = state.phase === 'ready'
  // How to get YouTube Music is the Tier row's to say, for this device.
  const blocker =
    ready && tier === 'free'
      ? `${state.platform === 'web' ? 'This browser' : 'This app'} can't reach YouTube Music, so there is nothing to test.`
      : resolver === unavailableResolver
        ? "This version of FXM can't resolve YouTube songs yet, so the self-test can't run."
        : undefined

  function start() {
    const ctx = connectionContext('music')
    if (ctx === undefined) return
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    const probe = createPlaybackProbe()
    // From the click itself, so browsers that want a tap let this element play after the wait.
    probe.prime()
    setRunning(true)
    setStep(undefined)
    setReport(undefined)
    void runSongSelfTest({
      resolver,
      probe,
      context: () => ({ ...ctx, signal: abort.signal }),
      signal: abort.signal,
      onStep: setStep,
    })
      .then((result) => {
        if (controller.current === abort) setReport(result)
      })
      .finally(() => {
        probe.dispose()
        if (controller.current === abort) {
          setRunning(false)
          controller.current = undefined
        }
      })
  }

  return (
    <Row label="Song self-test">
      <p className="text-sm text-text-muted">
        Resolves “{SELF_TEST_SONG.title}” by {SELF_TEST_SONG.artist} on YouTube Music and plays a
        few seconds of it, to show whether YouTube playback works here.
      </p>
      {blocker !== undefined && <p className="text-sm">{blocker}</p>}
      <div className="flex flex-wrap items-center gap-3">
        {/* One button for both, so keyboard focus stays on it when the test starts and ends. */}
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary' })}
          disabled={!running && (!ready || blocker !== undefined)}
          onClick={running ? () => controller.current?.abort() : start}
        >
          {running ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
          {running ? 'Stop' : 'Resolve and play one song'}
        </button>
      </div>
      <div aria-live="polite" className="min-h-6">
        {running ? (
          <p className="flex items-center gap-2 text-sm">
            <LoaderCircle
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            {stepText(step)}
          </p>
        ) : (
          report !== undefined && <Report report={report} />
        )}
      </div>
    </Row>
  )
}

export function DiagnosticsSection() {
  const state = useConnection()
  const headingId = useId()
  const detecting = isDetecting(state)
  const tier = connectionTier(state)

  return (
    <section
      id="diagnostics"
      aria-labelledby={headingId}
      className="scroll-mt-[calc(var(--shell-top)+1rem)] space-y-3"
    >
      <h2 id={headingId} className="px-1 text-lg font-bold tracking-tight">
        Diagnostics
      </h2>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface">
        <Row label="Tier">
          <div aria-live="polite" className="space-y-1">
            <p className="text-lg font-bold">
              {detecting ? 'Checking…' : <TierName tier={tier} />}
            </p>
            {!detecting && <p className="text-sm">{TIER_INFO[tier].summary}</p>}
            <ul className="space-y-1 text-sm text-text-muted">
              {explainConnection(state).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <p className="text-sm">
            <Link to="/connect" className={standaloneLinkClasses}>
              What each tier plays, and the install guides
            </Link>
          </p>
        </Row>
        <Row label="Details">
          <DetailList state={state} />
          <button
            type="button"
            className={buttonClasses({ variant: 'secondary' })}
            disabled={state.phase !== 'ready'}
            // Not `disabled` while it runs: focus would leave the button.
            aria-disabled={state.rechecking}
            onClick={() => void recheckConnection()}
          >
            <RefreshCw
              aria-hidden="true"
              className={state.rechecking ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
            {state.rechecking ? 'Checking…' : 'Check again'}
          </button>
        </Row>
        <SongSelfTest state={state} />
      </div>
    </section>
  )
}
