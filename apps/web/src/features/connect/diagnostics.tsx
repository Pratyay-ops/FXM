/**
 * Settings → Diagnostics: the current tier and why, the details behind it (FXM Connect, the Lite
 * self-test, what YouTube and Spotify allow, the request budget), a re-check, the "resolve and
 * play one song" self-test (docs/ARCHITECTURE.md §10) and, after it, the YouTube audio check
 * (`audio-check.ts`).
 *
 * @module
 */

import { CircleCheck, CircleX, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import {
  type AudioCheckResult,
  audioCheckPending,
  audioCheckSkip,
  audioCheckUrl,
  describeAudioCheck,
  runAudioCheck,
} from './audio-check'
import {
  type ConnectionState,
  connectionContext,
  recheckConnection,
  useConnection,
} from './connection'
import {
  budgetSummary,
  connectSummary,
  failureText,
  liteSummary,
  resolveErrorText,
  seconds,
} from './diagnostics-text'
import {
  connectionTier,
  describeSpotify,
  describeYouTube,
  explainConnection,
  isDetecting,
} from './explain'
import { createPlaybackProbe, type ProbeResult } from './playback-probe'
import { SELF_TEST_SONG, type SongResolver, unavailableResolver, useSongResolver } from './resolver'
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

/** Where the YouTube audio check stands. */
type AudioCheckState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'checking' }
  | { readonly phase: 'done'; readonly result: AudioCheckResult }

/** The song self-test and the YouTube audio check after it: one run, stopped by one button. */
interface DiagnosticsRun {
  readonly running: boolean
  readonly step: SelfTestStep | undefined
  readonly report: SelfTestReport | undefined
  readonly audio: AudioCheckState
  start(): void
  stop(): void
}

function useDiagnosticsRun(resolver: SongResolver): DiagnosticsRun {
  const [running, setRunning] = useState(false)
  const [step, setStep] = useState<SelfTestStep>()
  const [report, setReport] = useState<SelfTestReport>()
  const [audio, setAudio] = useState<AudioCheckState>({ phase: 'idle' })
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => controller.current?.abort(), [])

  /** Reads the stream the self-test ended on, when FXM Connect could read it here. */
  async function checkAudio(result: SelfTestReport, signal: AbortSignal, current: () => boolean) {
    // Without FXM Connect, or in Lite, the row says why from the connection state alone.
    if (result.status === 'cancelled' || audioCheckSkip(useConnection.getState()) !== undefined) {
      return
    }
    const url = result.status === 'skipped' ? undefined : audioCheckUrl(result.attempts)
    if (url === undefined) {
      setAudio({ phase: 'done', result: { kind: 'not-tested', reason: 'no-stream' } })
      return
    }
    setAudio({ phase: 'checking' })
    const checked = await runAudioCheck({ url, signal })
    if (current()) setAudio({ phase: 'done', result: checked })
  }

  function start() {
    const ctx = connectionContext('music')
    if (ctx === undefined) return
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    const current = () => controller.current === abort
    const probe = createPlaybackProbe()
    // From the click itself, so browsers that want a tap let this element play after the wait.
    probe.prime()
    setRunning(true)
    setStep(undefined)
    setReport(undefined)
    setAudio({ phase: 'idle' })
    void runSongSelfTest({
      resolver,
      probe,
      context: () => ({ ...ctx, signal: abort.signal }),
      signal: abort.signal,
      onStep: setStep,
    })
      .finally(() => probe.dispose())
      .then(async (result) => {
        if (!current()) return
        setReport(result)
        await checkAudio(result, abort.signal, current)
      })
      .finally(() => {
        if (current()) {
          setRunning(false)
          controller.current = undefined
        }
      })
  }

  return { running, step, report, audio, start, stop: () => controller.current?.abort() }
}

/** The "resolve and play one song" self-test. */
function SongSelfTest({
  state,
  resolver,
  run,
}: {
  state: ConnectionState
  resolver: SongResolver
  run: DiagnosticsRun
}) {
  const { running, step, report } = run
  const tier = connectionTier(state)
  const ready = state.phase === 'ready'
  // How to get YouTube Music is the Tier row's to say, for this device.
  const blocker =
    ready && tier === 'free'
      ? `${state.platform === 'web' ? 'This browser' : 'This app'} can't reach YouTube Music, so there is nothing to test.`
      : resolver === unavailableResolver
        ? "This version of FXM can't resolve YouTube songs yet, so the self-test can't run."
        : undefined

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
          onClick={running ? run.stop : run.start}
        >
          {running ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
          {running ? 'Stop' : 'Resolve and play one song'}
        </button>
      </div>
      <div aria-live="polite" className="min-h-6">
        {/* The report shows as soon as the self-test ends, while the audio check runs. */}
        {running && report === undefined ? (
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

/** A YouTube audio check's result, in the style of the self-test's report. */
function AudioCheckOutcome({
  result,
  connectVersion,
}: {
  result: AudioCheckResult
  connectVersion: string | undefined
}) {
  if (result.kind === 'cancelled') return <p className="text-sm text-text-muted">Stopped.</p>
  const text = describeAudioCheck(result, connectVersion)
  if (text.tone === 'neutral') {
    return (
      <p className="text-sm">
        <span className="font-semibold">{text.title}.</span>{' '}
        <span className="text-text-muted">{text.explanation}</span>
      </p>
    )
  }
  return (
    <div className="space-y-1">
      <p className="flex gap-2 font-semibold">
        {text.tone === 'good' ? (
          <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" />
        ) : (
          <CircleX aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
        )}
        <span>{text.title}</span>
      </p>
      <p className="text-sm text-text-muted">{text.explanation}</p>
      {text.advice !== undefined && <p className="text-sm">{text.advice}</p>}
    </div>
  )
}

/** The YouTube audio check: whether FXM Connect can read the stream the self-test found. */
function AudioCheck({ state, audio }: { state: ConnectionState; audio: AudioCheckState }) {
  const skip = audioCheckSkip(state)
  const connectVersion = state.connect?.version
  return (
    <Row label="YouTube audio">
      <p className="text-sm text-text-muted">
        Whether FXM Connect can read YouTube audio here, which YouTube downloads and the equalizer
        need. It runs after the song self-test and reads the first kilobyte of the stream the
        self-test found.
      </p>
      <div aria-live="polite" className="min-h-6">
        {skip !== undefined ? (
          <AudioCheckOutcome
            result={{ kind: 'not-tested', reason: skip }}
            connectVersion={connectVersion}
          />
        ) : audioCheckPending(state) ? null : audio.phase === 'checking' ? (
          <p className="flex items-center gap-2 text-sm">
            <LoaderCircle
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            Reading the first kilobyte of the song's audio…
          </p>
        ) : (
          audio.phase === 'done' && (
            <AudioCheckOutcome result={audio.result} connectVersion={connectVersion} />
          )
        )}
      </div>
    </Row>
  )
}

export function DiagnosticsSection() {
  const state = useConnection()
  // The ladder arrives with YouTube's code, which may load after this renders.
  const resolver = useSongResolver()
  const run = useDiagnosticsRun(resolver)
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
        <SongSelfTest state={state} resolver={resolver} run={run} />
        <AudioCheck state={state} audio={run.audio} />
      </div>
    </section>
  )
}
