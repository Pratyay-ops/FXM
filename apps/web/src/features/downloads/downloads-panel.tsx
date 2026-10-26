import { entityKey } from '@fxm/core'
import type { DownloadRecord } from '@fxm/downloads'
import {
  Info,
  type LucideIcon,
  Music,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react'
import { type ReactNode, useId, useState, useSyncExternalStore } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { IconButton } from '../../components/ui/icon-button'
import { usePlaylistView } from '../../db/hooks'
import type { TrackRow } from '../../db/repo'
import { DOWNLOADS_PLAYLIST_ID } from '../../db/types'
import { cn } from '../../lib/cn'
import { connectOrApps } from '../connect/explain'
import { CoverArt } from '../library/cover-art'
import { artistNames, artworkUrl, countLabel } from '../library/format'
import { chipClasses } from '../library/order-controls'
import {
  downloadTracks,
  pauseAllDownloads,
  pauseDownload,
  removeAllDownloads,
  removeDownloads,
  resumeAllDownloads,
  resumeDownload,
} from './actions'
import { RemoveDownloadDialog } from './download-button'
import { formatBytes, progressOf, statusLine } from './format'
import {
  useCanDownload,
  useDownloadContext,
  useDownloadRecords,
  useDownloadSupport,
  useStorageInfo,
} from './hooks'
import { ProgressBar } from './progress'

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => {
    window.removeEventListener('online', listener)
    window.removeEventListener('offline', listener)
  }
}

/** Whether the browser says it is online. */
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false,
    () => true,
  )
}

/** The bytes a download takes on the device now. */
function storedBytes(record: DownloadRecord): number {
  return record.status === 'completed' ? (record.bytesTotal ?? record.bytesDone) : record.bytesDone
}

/** A share of the meter, in percent, never so thin that a part that exists disappears. */
function share(part: number, whole: number): string {
  if (part <= 0 || whole <= 0) return '0%'
  return `${Math.min(100, Math.max(0.75, (part / whole) * 100))}%`
}

function Notice({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <p className="flex items-start gap-3 rounded-xl bg-elevated px-4 py-3 text-sm text-text-muted">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

/** How much the downloads take, how much room is left, and whether the browser keeps them. */
function StorageCard({ records }: { records: readonly DownloadRecord[] }) {
  const headingId = useId()
  const downloads = records.reduce((sum, record) => sum + storedBytes(record), 0)
  const completed = records.filter((record) => record.status === 'completed').length
  const info = useStorageInfo(downloads)
  const [confirming, setConfirming] = useState(false)
  const quota = info.estimate?.quota
  const usage = info.estimate?.usage
  const other = usage === undefined ? 0 : Math.max(0, usage - downloads)
  const free = quota === undefined || usage === undefined ? undefined : Math.max(0, quota - usage)
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-2xl border border-border p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-lg font-bold tracking-tight">
          On this device
        </h2>
        <p className="text-sm text-text-muted">{countLabel(completed, 'song')} ready offline</p>
      </div>
      {quota !== undefined && quota > 0 && (
        <>
          <meter
            className="sr-only"
            aria-label="Storage the downloads use"
            min={0}
            max={quota}
            value={Math.min(downloads, quota)}
            aria-valuetext={`${formatBytes(downloads)} of ${formatBytes(quota)}`}
          />
          <div
            aria-hidden="true"
            className="flex h-2 w-full overflow-hidden rounded-full bg-text/12 forced-colors:border forced-colors:border-[CanvasText]"
          >
            <div
              className="h-full bg-accent forced-colors:bg-[Highlight]"
              style={{ width: share(downloads, quota) }}
            />
            <div
              className="h-full bg-text-muted forced-colors:bg-[CanvasText]"
              style={{ width: share(other, quota) }}
            />
          </div>
        </>
      )}
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-text-muted">
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="size-2.5 rounded-full bg-accent" />
          Downloads: <span className="font-semibold text-text">{formatBytes(downloads)}</span>
        </li>
        {usage !== undefined && (
          <li className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2.5 rounded-full bg-text-muted" />
            Other FXM data: {formatBytes(other)}
          </li>
        )}
        {free !== undefined && <li>{formatBytes(free)} free for FXM</li>}
      </ul>
      {info.persisted === true && (
        <p className="flex items-center gap-2 text-sm text-text-muted">
          <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-accent" />
          Your browser keeps these downloads even when the device runs low on space.
        </p>
      )}
      {info.persisted === false && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-60 flex-1 text-sm text-text-muted">
            {info.refused
              ? 'Your browser didn’t agree to keep them this time. Some browsers agree once FXM is installed as an app.'
              : 'Your browser may delete downloads when the device runs low on space.'}
          </p>
          {!info.refused && (
            <button type="button" className={chipClasses()} onClick={() => void info.persist()}>
              <ShieldCheck aria-hidden="true" />
              Keep my downloads
            </button>
          )}
        </div>
      )}
      <div>
        <button
          type="button"
          className={chipClasses({ tone: 'danger' })}
          onClick={() => setConfirming(true)}
        >
          <Trash2 aria-hidden="true" />
          Remove all downloads
        </button>
      </div>
      <RemoveDownloadDialog
        open={confirming}
        count={records.length}
        title={records.length === 1 ? records[0]?.track.title : undefined}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          void removeAllDownloads()
        }}
      />
    </section>
  )
}

function ActiveRow({ record, online }: { record: DownloadRecord; online: boolean }) {
  const { track, status } = record
  const title = track.title
  const value = progressOf(record)
  const line = statusLine(record, online)
  const failed = status === 'failed'
  const stopped = status === 'paused' || failed
  return (
    <li className="flex items-center gap-3 rounded-lg px-1 py-2">
      <CoverArt
        src={artworkUrl(track.artwork, 80)}
        seed={track.id}
        icon={Music}
        rounded="sm"
        className="size-10"
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate font-semibold">{title}</p>
          {value !== undefined && !failed && (
            <p className="shrink-0 text-xs text-text-muted tabular-nums">
              {Math.round(value * 100)}%
            </p>
          )}
        </div>
        <ProgressBar
          value={value}
          label={`Download of ${title}`}
          valueText={line}
          paused={status !== 'downloading' || !online}
        />
        {/* A failure's reason wraps rather than hide; phones leave the artist out for room. */}
        <p className={cn('text-sm', failed ? 'text-danger' : 'truncate text-text-muted')}>
          {artistNames(track) && <span className="max-sm:hidden">{artistNames(track)} · </span>}
          {line}
        </p>
      </div>
      {stopped ? (
        <IconButton
          label={failed ? `Try downloading ${title} again` : `Resume downloading ${title}`}
          icon={failed ? <RotateCcw /> : <Play />}
          size="sm"
          onClick={() => void resumeDownload(record.id)}
        />
      ) : (
        <IconButton
          label={`Pause downloading ${title}`}
          icon={<Pause />}
          size="sm"
          onClick={() => void pauseDownload(record.id)}
        />
      )}
      <IconButton
        label={`Cancel the download of ${title}`}
        icon={<X />}
        size="sm"
        onClick={() => void removeDownloads([track])}
      />
    </li>
  )
}

/** The downloads on their way: waiting, running, paused or failed. */
function ActiveDownloads({ records }: { records: readonly DownloadRecord[] }) {
  const headingId = useId()
  const online = useOnline()
  const running = records.some(
    (record) => record.status === 'queued' || record.status === 'downloading',
  )
  const stopped = records.some((record) => record.status === 'paused' || record.status === 'failed')
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="text-lg font-bold tracking-tight">
          Downloading <span className="font-semibold text-text-muted">{records.length}</span>
        </h2>
        <div className="flex flex-wrap gap-2">
          {running && (
            <button
              type="button"
              className={chipClasses()}
              onClick={() => void pauseAllDownloads()}
            >
              <Pause aria-hidden="true" />
              Pause all
            </button>
          )}
          {stopped && (
            <button
              type="button"
              className={chipClasses()}
              onClick={() => void resumeAllDownloads()}
            >
              <Play aria-hidden="true" />
              Resume all
            </button>
          )}
        </div>
      </div>
      {!online && (
        <Notice icon={WifiOff}>You're offline. Downloads continue when you're back online.</Notice>
      )}
      <ul aria-label="Downloads on their way" className="-mx-1">
        {records.map((record) => (
          <ActiveRow key={record.id} record={record} online={online} />
        ))}
      </ul>
    </section>
  )
}

/**
 * Songs in the Downloads playlist that aren't downloaded on this device, e.g. after restoring
 * a backup from another device: download them here, or take them off the list.
 */
function MissingNotice({ rows }: { rows: readonly TrackRow[] }) {
  const canDownload = useCanDownload()
  const downloadable = rows.flatMap((row) =>
    row.track && canDownload(row.track) ? [row.track] : [],
  )
  const count = rows.length
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3">
      <p className="min-w-60 flex-1 text-sm text-text-muted">
        {countLabel(count, 'song')} in Downloads {count === 1 ? 'isn’t' : 'aren’t'} downloaded on
        this device.
      </p>
      {downloadable.length > 0 && (
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary' })}
          onClick={() => void downloadTracks(downloadable)}
        >
          Download {count === 1 ? 'it' : 'them'}
        </button>
      )}
      <button
        type="button"
        className={buttonClasses({ variant: 'ghost' })}
        onClick={() =>
          void removeDownloads(rows.map((row) => ({ id: row.id, title: row.track?.title })))
        }
      >
        Remove from Downloads
      </button>
    </div>
  )
}

/**
 * The download manager in the library's Downloads tab: how much room the downloads take and
 * whether the browser keeps them, the downloads on their way with their progress and controls,
 * and songs in the playlist that aren't on this device. The playlist itself, in the order the
 * user chose, is the library's (stage 2.6).
 */
export function DownloadsPanel() {
  const live = useDownloadRecords()
  const playlist = usePlaylistView(DOWNLOADS_PLAYLIST_ID)
  const support = useDownloadSupport()
  const ctx = useDownloadContext()
  if (live.status === 'loading') return null
  if (live.status === 'error') {
    return (
      <Notice icon={Info}>
        FXM can't read your downloads in this browser window. Private windows and turned-off site
        data can block it.
      </Notice>
    )
  }
  const { pending, completed } = live.data
  const records = [...pending, ...completed]
  const known = new Set(records.map((record) => record.id))
  const rows = playlist.status === 'ready' ? (playlist.data?.rows ?? []) : []
  const missing = rows.filter((row) => !known.has(entityKey(row.id)))
  return (
    <div className="space-y-6">
      {support === 'unsupported' && (
        <Notice icon={Info}>
          This browser can't store downloads. A current Chrome, Edge, Firefox or Safari can, outside
          private windows.
        </Notice>
      )}
      {support === 'supported' && !ctx.capabilities.mediaBytes && (
        <Notice icon={Info}>
          Downloading songs from YouTube Music takes {connectOrApps()}. Songs from Internet Archive
          and Jamendo download in any browser.
        </Notice>
      )}
      {records.length > 0 && <StorageCard records={records} />}
      {pending.length > 0 && <ActiveDownloads records={pending} />}
      {missing.length > 0 && <MissingNotice rows={missing} />}
    </div>
  )
}
