import {
  type ImportReport,
  type ImportState,
  importReport,
  needsReview,
  type ReviewDecision,
  type RowStatus,
  reportToCsv,
  reportToJson,
} from '@fxm/sources/import'
import { ArrowLeft, CheckCheck, FileDown } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { PageTitle } from '../../components/ui/page'
import { PageSkeleton } from '../../components/ui/skeleton'
import { type TabItem, TabPanel, Tabs } from '../../components/ui/tabs'
import { useLive } from '../../db/hooks'
import type { ImportProgressRecord } from '../../db/types'
import { countLabel } from '../library/format'
import { playlistPath } from '../library/paths'
import { failureText } from '../library/playlist-dialogs'
import { StatusToast, showStatus } from '../library/status'
import { countsText, kindLabel, lengthText, shownStatus } from './format'
import { ImportActions, ImportProgress, ImportStatusLine } from './import-list'
import { IMPORT_PATH } from './paths'
import { ReviewItem } from './review-item'
import { confirmLikelyMatches, loadImportState, reviewRow, useImportRunner } from './runner'
import { type ImportServicesAccess, useImportServices } from './services'

type DetailTab = 'review' | 'all'

/** How many rows a list shows before "Show more". */
const PAGE = 100

const STATUS_WORDS: Readonly<Record<RowStatus, string>> = {
  pending: 'Waiting',
  ready: 'Plays as it is',
  matched: 'Matched',
  review: 'To review',
  'not-found': 'Not found',
  failed: 'Failed',
  confirmed: 'Confirmed',
  skipped: 'Skipped',
}

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

function Totals({ report }: { report: ImportReport }) {
  const { totals } = report
  const items: [string, number][] = [
    ['Matched', totals.matched + totals.ready + totals.confirmed],
    ['To review', totals.review],
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

function AllRows({ state, report }: { state: ImportState; report: ImportReport }) {
  const [shown, setShown] = useState(PAGE)
  return (
    <div className="space-y-3">
      <ol className="divide-y divide-border rounded-2xl border border-border">
        {report.rows.slice(0, shown).map((row) => (
          <li key={row.position} className="flex items-center gap-3 px-3 py-2">
            <span className="w-8 shrink-0 text-right text-sm text-text-muted tabular-nums">
              {row.position}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">
                {row.title || state.rows[row.position - 1]?.location || 'Unknown song'}
              </span>
              <span className="block truncate text-sm text-text-muted">
                {row.match
                  ? `→ ${row.match.title} · ${row.match.artists.join(', ')} ${lengthText(row.match.durationMs)}`
                  : row.artists.join(', ')}
              </span>
            </span>
            <span className="shrink-0 rounded-full bg-elevated px-2.5 py-0.5 text-xs font-semibold">
              {STATUS_WORDS[row.status]}
            </span>
          </li>
        ))}
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

function ReviewRows({ id, state }: { id: string; state: ImportState }) {
  const [shown, setShown] = useState(PAGE)
  const indices = state.results.flatMap((result, index) => (needsReview(result) ? [index] : []))
  if (indices.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-text-muted">
        Nothing to review.
      </p>
    )
  }
  const decide = async (index: number, decision: ReviewDecision) => {
    try {
      await reviewRow(id, index, decision)
    } catch (error) {
      showStatus(failureText(error))
    }
  }
  return (
    <div className="space-y-3">
      <p className="max-w-prose text-sm text-text-muted">
        “Use this song” plays your choice from now on. “Skip” leaves a song as it is: one from
        Spotify or YouTube stays in the playlist and asks again when you play it, and one from a
        file stays out of the playlist.
      </p>
      <ul className="space-y-3">
        {indices.slice(0, shown).map((index) => {
          const row = state.rows[index]
          const result = state.results[index]
          if (row === undefined || result === null || result === undefined) return null
          return (
            <ReviewItem
              key={index}
              index={index}
              row={row}
              result={result}
              onDecision={(decision) => decide(index, decision)}
            />
          )
        })}
      </ul>
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
}: {
  record: ImportProgressRecord
  state: ImportState
  services: ImportServicesAccess
}) {
  const report = useMemo(() => importReport(state, record.label), [state, record.label])
  const reviewCount = report.totals.review + report.totals.notFound
  const [tab, setTab] = useState<DetailTab>(reviewCount > 0 ? 'review' : 'all')
  const tabsId = useId()
  const autoOn = services.current?.autoMatch() ?? false
  const tabs: readonly TabItem<DetailTab>[] = [
    { value: 'review', label: `To review (${reviewCount.toLocaleString('en')})` },
    { value: 'all', label: `All songs (${report.rows.length.toLocaleString('en')})` },
  ]
  const confirmLikely = async () => {
    try {
      const confirmed = await confirmLikelyMatches(record.id)
      showStatus(`Confirmed ${countLabel(confirmed, 'match', 'matches')}`)
    } catch (error) {
      showStatus(failureText(error))
    }
  }
  return (
    <>
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
      {!autoOn && report.totals.likely > 0 && (
        <div className="space-y-3 rounded-2xl border border-accent p-4">
          <p className="text-sm">
            FXM doesn’t play matches by itself yet, so even sure matches wait for you.{' '}
            <strong>{countLabel(report.totals.likely, 'match', 'matches')}</strong> look right: the
            same title, artists and length, or the same recording by ISRC.
          </p>
          <button type="button" className={buttonClasses()} onClick={confirmLikely}>
            <CheckCheck aria-hidden="true" />
            Confirm {countLabel(report.totals.likely, 'likely match', 'likely matches')}
          </button>
        </div>
      )}
      <Tabs label="Songs" id={tabsId} items={tabs} value={tab} onChange={setTab} />
      <TabPanel id={tabsId} value={tab}>
        {tab === 'review' ? (
          <ReviewRows id={record.id} state={state} />
        ) : (
          <AllRows state={state} report={report} />
        )}
      </TabPanel>
    </>
  )
}

/** `/import/:id`: one import's progress, match report and review list. */
export function ImportDetailPage() {
  const { id = '' } = useParams()
  const services = useImportServices()
  const live = useLive((repo) => repo.getImport(id), [id])
  const record = live.status === 'ready' ? live.data : undefined
  const [state, setState] = useState<ImportState | null | undefined>(undefined)
  const activeId = useImportRunner((runner) => runner.activeId)
  const queued = useImportRunner((runner) => runner.queued)
  const activity = useImportRunner((runner) => (runner.activeId === id ? runner.activity : null))
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
  const status = shownStatus(record, activeId, queued)
  return (
    <div className="space-y-6 pt-2 md:pt-4">
      {back}
      <div className="space-y-2">
        <PageTitle>{record.label}</PageTitle>
        <p className="text-sm text-text-muted">
          {kindLabel(record.kind)} · {countsText(record)}
        </p>
      </div>
      <div className="space-y-3">
        <ImportProgress record={record} />
        <ImportStatusLine record={record} status={status} activity={activity} />
        <div className="flex flex-wrap items-center gap-2">
          {record.playlistId !== undefined && (
            <Link
              to={playlistPath(record.playlistId)}
              className={buttonClasses({ variant: 'secondary' })}
            >
              Open playlist
            </Link>
          )}
          <ImportActions record={record} status={status} services={services} />
        </div>
      </div>
      {state === undefined ? (
        <PageSkeleton />
      ) : state === null ? (
        <p role="alert" className="text-text-muted">
          This import’s progress can’t be read, so its songs can’t be shown.
        </p>
      ) : (
        <Detail record={record} state={state} services={services} />
      )}
      <StatusToast />
    </div>
  )
}
