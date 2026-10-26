import {
  type ImportReport,
  type ImportState,
  importBlockOf,
  importReport,
  needsReview,
  type ReviewDecision,
  type RowStatus,
  reportToCsv,
  reportToJson,
} from '@fxm/sources/import'
import { ArrowLeft, CheckCheck, FileDown, Undo2 } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { PageTitle } from '../../components/ui/page'
import { PageSkeleton } from '../../components/ui/skeleton'
import { type TabItem, TabPanel, Tabs } from '../../components/ui/tabs'
import { useLive } from '../../db/hooks'
import type { ImportProgressRecord } from '../../db/types'
import { countLabel } from '../library/format'
import { playlistPath } from '../library/paths'
import { showStatus } from '../library/status'
import { focusWhenReady, importTitleId } from './focus'
import { countsText, kindLabel, lengthText, shownStatus } from './format'
import { useMatchingAvailability, useRunnerView } from './hooks'
import {
  actionFailureText,
  ImportControls,
  ImportMenu,
  ImportProgress,
  ImportStatusLine,
} from './import-list'
import { MatchingNotice } from './matching-notice'
import { IMPORT_PATH } from './paths'
import { candidatesOf, DecidedItem, ReviewItem, reviewTitleId, rowTitle } from './review-item'
import {
  confirmLikelyMatches,
  loadImportState,
  reopenRows,
  reviewRow,
  useImportRunner,
} from './runner'
import { type ImportServicesAccess, useImportServices } from './services'

type DetailTab = 'review' | 'all'

/** How many rows a list shows before "Show more". */
const PAGE = 100

const STATUS_WORDS: Readonly<Record<RowStatus, string>> = {
  pending: 'Waiting',
  ready: 'Plays as it is',
  matched: 'Matched',
  review: 'Best guess',
  'not-found': 'Not found',
  failed: 'Failed',
  confirmed: 'Confirmed',
  skipped: 'Skipped',
}

const NOTICE =
  'flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-elevated px-3 py-1 text-sm'
const NOTICE_LINK =
  'inline-flex h-touch items-center gap-1.5 rounded-md font-semibold text-accent underline-offset-2 hover:underline disabled:opacity-50 lg:h-8 lg:pointer-coarse:h-touch [&_svg]:size-4'

/** Saves text as a file through a temporary download link. */
function download(text: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** A file name from an import's label: "Road trip" → "road-trip-match-report". */
function reportName(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase()
    .slice(0, 60)
  return `${slug || 'import'}-match-report`
}

/** What a decision did, in the review list's own words. */
function decisionText(state: ImportState, index: number, decision: ReviewDecision): string {
  if (decision.action === 'skip') return 'Skipped'
  const result = state.results[index]
  const chosen = result
    ? candidatesOf(result).find((candidate) => candidate.ref === decision.ref)
    : undefined
  return chosen === undefined ? 'Confirmed' : `Using “${chosen.title}”`
}

/**
 * The totals of the match report. "To review" counts every song that waits for the user: the
 * best guesses and the songs nothing was found for, which the tiles show apart.
 */
function Totals({ report }: { report: ImportReport }) {
  const { totals } = report
  const items: [string, number][] = [
    ['Matched', totals.matched + totals.ready + totals.confirmed],
    ['Best guesses', totals.review],
    ['Not found', totals.notFound],
    ['Failed', totals.failed],
    ['Waiting', totals.pending],
  ]
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {items.map(([label, value]) => (
          <div key={label} className="rounded-xl bg-elevated p-3">
            <dt className="text-xs font-semibold text-text-muted">{label}</dt>
            <dd className="text-2xl font-bold tabular-nums">{value.toLocaleString('en')}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-text-muted">
        {[
          totals.isrcVerified > 0 ? `${countLabel(totals.isrcVerified, 'song')} found by ISRC` : '',
          totals.musicBrainz > 0
            ? `${countLabel(totals.musicBrainz, 'song')} looked up on MusicBrainz`
            : '',
          totals.noDuration > 0
            ? `${countLabel(totals.noDuration, 'song')} without a length, so never matched automatically`
            : '',
          totals.skipped > 0 ? `${countLabel(totals.skipped, 'song')} skipped` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </div>
  )
}

function AllRows({
  state,
  report,
  disabled,
  onChange,
}: {
  state: ImportState
  report: ImportReport
  disabled: boolean
  /** Reopens a decided row, to choose again. */
  onChange: (index: number) => void
}) {
  const [shown, setShown] = useState(PAGE)
  return (
    <div className="space-y-3">
      <ol className="divide-y divide-border rounded-2xl border border-border">
        {report.rows.slice(0, shown).map((row) => {
          const index = row.position - 1
          const decided = state.results[index]?.review
          // A decision made in this import's review list; a pin from elsewhere has no time.
          const changeable = decided !== undefined && decided.at > 0
          const title = row.title || state.rows[index]?.location || 'Unknown song'
          return (
            <li key={row.position} className="flex items-center gap-3 px-3 py-2">
              <span className="w-8 shrink-0 text-right text-sm text-text-muted tabular-nums">
                {row.position}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{title}</span>
                <span className="block truncate text-sm text-text-muted">
                  {row.match
                    ? `→ ${row.match.title} · ${row.match.artists.join(', ')} ${lengthText(row.match.durationMs)}`
                    : row.artists.join(', ')}
                </span>
              </span>
              <span className="shrink-0 rounded-full bg-elevated px-2.5 py-0.5 text-xs font-semibold">
                {STATUS_WORDS[row.status]}
              </span>
              {changeable && (
                <button
                  type="button"
                  disabled={disabled}
                  className={buttonClasses({ variant: 'ghost', className: 'h-9 shrink-0 px-3' })}
                  aria-label={`Change the song for ${title}`}
                  onClick={() => onChange(index)}
                >
                  Change
                </button>
              )}
            </li>
          )
        })}
      </ol>
      {report.rows.length > shown && (
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary' })}
          onClick={() => setShown((value) => value + PAGE)}
        >
          Show more
        </button>
      )}
    </div>
  )
}

function ReviewRows({
  id,
  state,
  disabled,
}: {
  id: string
  state: ImportState
  disabled: boolean
}) {
  const [shown, setShown] = useState(PAGE)
  // Rows decided on this page stay in place, as one line with Undo, until the page closes.
  const [decided, setDecided] = useState<ReadonlyMap<number, string>>(new Map())
  const doneId = useId()
  const indices = state.results.flatMap((result, index) =>
    needsReview(result) || decided.has(index) ? [index] : [],
  )
  const isClosed = (index: number) =>
    decided.has(index) && state.results[index]?.review !== undefined
  const open = indices.filter((index) => !isClosed(index))

  if (indices.length === 0) {
    return (
      <p
        id={doneId}
        tabIndex={-1}
        className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-text-muted outline-none"
      >
        Nothing to review.
      </p>
    )
  }

  const decide = async (index: number, decision: ReviewDecision) => {
    const title = rowTitle(state.rows[index] ?? { title: '', artists: [] })
    const text = decisionText(state, index, decision)
    try {
      await reviewRow(id, index, decision)
    } catch (error) {
      showStatus(actionFailureText(error))
      return
    }
    setDecided((current) => new Map(current).set(index, text))
    showStatus(decision.action === 'skip' ? `Skipped “${title}”` : `${text} for “${title}”`)
    // On to the next song that waits, else the end of the list.
    const next = open.find((other) => other > index) ?? open.find((other) => other !== index)
    focusWhenReady(() => document.getElementById(next === undefined ? doneId : reviewTitleId(next)))
  }

  const undo = async (index: number) => {
    const title = rowTitle(state.rows[index] ?? { title: '', artists: [] })
    try {
      await reopenRows(id, [index])
    } catch (error) {
      showStatus(actionFailureText(error))
      return
    }
    showStatus(`“${title}” waits for review again`)
    focusWhenReady(() => document.getElementById(reviewTitleId(index)))
  }

  return (
    <div className="space-y-3">
      <p className="max-w-prose text-sm text-text-muted">
        “Use this song” plays your choice from now on. “Skip” leaves a song as it is: one from
        Spotify or YouTube stays in the playlist and asks again when you play it, and one from a
        file stays out of the playlist. Changed your mind? Undo, or Change in All songs.
      </p>
      <ul className="space-y-3">
        {indices.slice(0, shown).map((index) => {
          const row = state.rows[index]
          const result = state.results[index]
          if (row === undefined || result === null || result === undefined) return null
          const text = decided.get(index)
          if (text !== undefined && isClosed(index)) {
            return (
              <DecidedItem
                key={`decided-${index}`}
                index={index}
                row={row}
                text={text}
                disabled={disabled}
                onUndo={() => void undo(index)}
              />
            )
          }
          return (
            <ReviewItem
              key={index}
              index={index}
              row={row}
              result={result}
              disabled={disabled}
              onDecision={(decision) => decide(index, decision)}
            />
          )
        })}
      </ul>
      {open.length === 0 && (
        <p id={doneId} tabIndex={-1} className="text-sm font-semibold outline-none">
          All songs reviewed.
        </p>
      )}
      {indices.length > shown && (
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary' })}
          onClick={() => setShown((value) => value + PAGE)}
        >
          Show more
        </button>
      )}
    </div>
  )
}

function Detail({
  record,
  state,
  services,
  disabled,
}: {
  record: ImportProgressRecord
  state: ImportState
  services: ImportServicesAccess
  /** Whether another tab runs the import: then this page only shows it. */
  disabled: boolean
}) {
  const report = useMemo(() => importReport(state, record.label), [state, record.label])
  const reviewCount = report.totals.review + report.totals.notFound
  const [tab, setTab] = useState<DetailTab>(reviewCount > 0 ? 'review' : 'all')
  const [confirmed, setConfirmed] = useState<number[] | null>(null)
  const [working, setWorking] = useState(false)
  const tabsId = useId()
  const reportId = useId()
  const songsId = useId()
  const autoOn = services.current?.autoMatch() ?? false
  const tabs: readonly TabItem<DetailTab>[] = [
    { value: 'review', label: `To review (${reviewCount.toLocaleString('en')})` },
    { value: 'all', label: `All songs (${report.rows.length.toLocaleString('en')})` },
  ]
  const focusReview = () => {
    setTab('review')
    focusWhenReady(() => document.getElementById(`${tabsId}-tab-review`))
  }
  const confirmLikely = async () => {
    setWorking(true)
    try {
      const rows = await confirmLikelyMatches(record.id)
      setConfirmed(rows)
      showStatus(`Confirmed ${countLabel(rows.length, 'match', 'matches')}`)
      focusReview()
    } catch (error) {
      showStatus(actionFailureText(error))
    } finally {
      setWorking(false)
    }
  }
  const undoConfirmed = async () => {
    if (confirmed === null) return
    setWorking(true)
    try {
      const reopened = await reopenRows(record.id, confirmed)
      setConfirmed(null)
      showStatus(`${countLabel(reopened, 'match', 'matches')} wait for review again`)
      focusReview()
    } catch (error) {
      showStatus(actionFailureText(error))
    } finally {
      setWorking(false)
    }
  }
  const change = async (index: number) => {
    try {
      await reopenRows(record.id, [index])
    } catch (error) {
      showStatus(actionFailureText(error))
      return
    }
    setTab('review')
    showStatus(`Choose again for “${rowTitle(state.rows[index] ?? { title: '', artists: [] })}”`)
    focusWhenReady(() => document.getElementById(reviewTitleId(index)), { scroll: true })
  }
  return (
    <>
      <section aria-labelledby={reportId} className="space-y-3">
        <h2 id={reportId} className="text-xl font-bold tracking-tight">
          Match report
        </h2>
        <Totals report={report} />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClasses({ variant: 'secondary' })}
            onClick={() =>
              download(reportToCsv(report), `${reportName(record.label)}.csv`, 'text/csv')
            }
          >
            <FileDown aria-hidden="true" />
            Match report (CSV)
          </button>
          <button
            type="button"
            className={buttonClasses({ variant: 'ghost' })}
            onClick={() =>
              download(reportToJson(report), `${reportName(record.label)}.json`, 'application/json')
            }
          >
            <FileDown aria-hidden="true" />
            JSON
          </button>
        </div>
      </section>
      {confirmed !== null && confirmed.length > 0 && (
        <div className={NOTICE}>
          <p className="mr-auto py-2 text-text-muted">
            Confirmed {countLabel(confirmed.length, 'likely match', 'likely matches')}.
          </p>
          <button
            type="button"
            className={NOTICE_LINK}
            disabled={working || disabled}
            onClick={undoConfirmed}
          >
            <Undo2 aria-hidden="true" />
            Undo
          </button>
        </div>
      )}
      {!autoOn && report.totals.likely > 0 && (
        <div className="space-y-3 rounded-2xl border border-accent p-4">
          <p className="text-sm">
            FXM doesn’t play matches by itself yet, so even sure matches wait for you.{' '}
            <strong>{countLabel(report.totals.likely, 'match', 'matches')}</strong>{' '}
            {report.totals.likely === 1 ? 'looks' : 'look'} right: the same title, artists and
            length, or the same recording by ISRC.
          </p>
          <button
            type="button"
            className={buttonClasses()}
            disabled={working || disabled}
            onClick={confirmLikely}
          >
            <CheckCheck aria-hidden="true" />
            Confirm {countLabel(report.totals.likely, 'likely match', 'likely matches')}
          </button>
        </div>
      )}
      <section aria-labelledby={songsId} className="space-y-3">
        <h2 id={songsId} className="sr-only">
          Songs
        </h2>
        <Tabs label="Songs" id={tabsId} items={tabs} value={tab} onChange={setTab} />
        <TabPanel id={tabsId} value={tab}>
          {tab === 'review' ? (
            <ReviewRows id={record.id} state={state} disabled={disabled} />
          ) : (
            <AllRows
              state={state}
              report={report}
              disabled={disabled}
              onChange={(index) => void change(index)}
            />
          )}
        </TabPanel>
      </section>
    </>
  )
}

/** `/import/:id`: one import's progress, match report and review list. */
export function ImportDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const services = useImportServices()
  const live = useLive((repo) => repo.getImport(id), [id])
  const record = live.status === 'ready' ? live.data : undefined
  const [state, setState] = useState<ImportState | null | undefined>(undefined)
  const runner = useRunnerView(record?.status === 'running' || record?.status === 'pending')
  const activity = useImportRunner((current) => (current.activeId === id ? current.activity : null))
  const matching = useMatchingAvailability(services)
  const updatedAt = record?.updatedAt

  useEffect(() => {
    if (updatedAt === undefined) return
    let current = true
    loadImportState(id).then(
      // A copy: the running job changes its own state in place.
      (loaded) => current && setState(loaded === null ? null : structuredClone(loaded)),
      () => current && setState(null),
    )
    return () => {
      current = false
    }
  }, [id, updatedAt])

  if (live.status === 'loading') return <PageSkeleton />
  const back = (
    <Link to={IMPORT_PATH} className={buttonClasses({ variant: 'ghost', className: '-ml-3' })}>
      <ArrowLeft aria-hidden="true" />
      All imports
    </Link>
  )
  if (record === undefined) {
    return (
      <div className="space-y-4 pt-2 md:pt-4">
        {back}
        <PageTitle>Import not found</PageTitle>
        <p className="text-text-muted">It may have been removed from the list.</p>
      </div>
    )
  }
  const status = shownStatus(record, runner)
  const elsewhere = status === 'elsewhere'
  const blocked = record.status === 'paused' ? importBlockOf(record.state) : undefined
  return (
    <div className="space-y-6 pt-2 md:pt-4">
      {back}
      <div className="space-y-2">
        <h1
          id={importTitleId(record.id)}
          tabIndex={-1}
          className="text-3xl font-extrabold tracking-tight break-words outline-none md:text-4xl"
        >
          {record.label}
        </h1>
        <p className="text-sm text-text-muted">
          {kindLabel(record.kind)} · {countsText(record)}
        </p>
      </div>
      <div className="space-y-3">
        <ImportProgress record={record} />
        <ImportStatusLine record={record} status={status} activity={activity} matching={matching} />
        <div className="flex flex-wrap items-center gap-2">
          {record.playlistId !== undefined && (
            <Link
              to={playlistPath(record.playlistId)}
              className={buttonClasses({ variant: 'secondary', className: 'h-9 px-4' })}
            >
              Open playlist
            </Link>
          )}
          <ImportControls record={record} status={status} services={services} resumeIsMain />
          <ImportMenu
            record={record}
            status={status}
            playlistInMenu={false}
            onRemoved={() => navigate(IMPORT_PATH)}
            className="ml-auto"
          />
        </div>
        {elsewhere && (
          <p className="text-sm text-text-muted">
            Another tab or window is running this import. Review its songs there, or here once it
            pauses or finishes.
          </p>
        )}
        {blocked === 'unsupported' && <MatchingNotice matching={matching} where="imports" />}
      </div>
      {state === undefined ? (
        <PageSkeleton />
      ) : state === null ? (
        <p role="alert" className="text-text-muted">
          This import’s progress can’t be read, so its songs can’t be shown.
        </p>
      ) : (
        <Detail record={record} state={state} services={services} disabled={elsewhere} />
      )}
    </div>
  )
}
