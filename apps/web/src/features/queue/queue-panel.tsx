import type { AudioCandidate, QueueContext, QueueItem, Track } from '@fxm/core'
import { formatTime } from '@fxm/player'
import { AudioLines, CircleHelp, GripVertical, ListMusic, X } from 'lucide-react'
import { type CSSProperties, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { iconButtonClasses } from '../../components/ui/icon-button'
import { cn } from '../../lib/cn'
import { entityPath, searchPath } from '../now-playing/browse-links'
import { getPlayer, usePlayerState } from '../now-playing/playback'
import { KIND_LABELS } from '../now-playing/stream-label'
import { TrackArtwork } from '../now-playing/track-artwork'
import { approveAllBestGuesses, playBestGuess } from './review-actions'
import { ReviewDialog } from './review-dialog'
import { useQueueReviewStore } from './review-store'
import { Switch } from './switch'
import { useDragReorder } from './use-drag-reorder'

/** How many upcoming songs show before "Show all". */
const PAGE_SIZE = 100

const SECTION_HEADING = 'text-xs font-bold tracking-[0.12em] text-text-muted uppercase'

function artistNames(track: Track): string {
  return track.artists.map((artist) => artist.name).join(', ')
}

/** The track's kind (for anything but a song) and artists, for a row's second line. */
function byline(track: Track): string {
  const kind = track.kind === 'song' ? undefined : KIND_LABELS[track.kind]
  return [kind, artistNames(track)].filter(Boolean).join(' · ')
}

function duration(track: Track): string | undefined {
  return track.durationMs === undefined ? undefined : formatTime(track.durationMs / 1000)
}

/** What a row says about its match: undefined when it plays its own audio or a sure match. */
function reviewLabel(
  item: QueueItem,
  bestGuess: AudioCandidate | undefined,
  playBestGuesses: boolean,
): string | undefined {
  if (bestGuess === undefined) return undefined
  // A best guess plays when the setting allows it, or once the user played it themselves.
  return playBestGuesses || item.candidate !== undefined ? 'Best guess' : 'Needs review'
}

function ReviewMark({ label }: { label: string }) {
  return (
    <span className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-accent">
      <CircleHelp aria-hidden="true" className="size-3.5 shrink-0" />
      {label}
    </span>
  )
}

/** "Playing from …", linked to the album, artist or playlist page once those exist. */
function PlayingFrom({ context }: { context: QueueContext }) {
  let to: string | undefined
  if (context.type === 'album' || context.type === 'artist' || context.type === 'playlist') {
    to = entityPath(context.id)
  } else if (context.type === 'search') {
    to = searchPath(context.query)
  }
  return (
    <p className="mt-1 truncate text-sm text-text-muted">
      Playing from{' '}
      {to === undefined ? (
        <span className="font-semibold text-text">{context.title}</span>
      ) : (
        <Link to={to} className="font-semibold text-text hover:underline">
          {context.title}
        </Link>
      )}
    </p>
  )
}

/** The review notice: how many songs need a look, a one-tap approval and the full list. */
function ReviewNotice({
  count,
  playBestGuesses,
  onApproveAll,
  onReview,
}: {
  count: number
  playBestGuesses: boolean
  onApproveAll: () => void
  onReview: () => void
}) {
  const headingId = useId()
  const one = count === 1
  let heading = one ? '1 song needs review' : `${count} songs need review`
  if (playBestGuesses) {
    heading = one ? '1 song plays a best guess' : `${count} songs play a best guess`
  }
  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <CircleHelp aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="font-semibold">
            {heading}
          </h3>
          <p className="mt-1 text-sm text-text-muted">
            {playBestGuesses
              ? 'FXM isn’t sure it found the right recording of these, but plays its best guess.'
              : 'FXM isn’t sure it found the right recording of these, so the queue skips them until you check them.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClasses({ className: 'h-10 px-4' })}
              onClick={onApproveAll}
            >
              Approve all
            </button>
            <button
              type="button"
              className={buttonClasses({ variant: 'secondary', className: 'h-10 px-4' })}
              onClick={onReview}
            >
              Review
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function CurrentRow({ item }: { item: QueueItem }) {
  const playing = usePlayerState((state) => state.status === 'playing')
  const { track } = item
  return (
    <div className="flex items-center gap-3 rounded-lg bg-elevated p-2">
      <TrackArtwork
        images={track.artwork}
        seed={track.id}
        size={48}
        rounded="sm"
        className="size-12"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-accent">{track.title}</p>
        <p className="truncate text-sm text-text-muted">{byline(track)}</p>
      </div>
      {playing && (
        <AudioLines role="img" aria-label="Playing" className="mr-1 size-5 shrink-0 text-accent" />
      )}
    </div>
  )
}

interface RowProps {
  item: QueueItem
  /** Position in the queue. */
  index: number
  bestGuess: AudioCandidate | undefined
  playBestGuesses: boolean
  /** Whether this row is the one being dragged. */
  dragging: boolean
  /** Whether any row is being dragged: the others then slide aside. */
  sliding: boolean
  style: CSSProperties | undefined
  handleProps: ReturnType<ReturnType<typeof useDragReorder>['handleProps']>
  hintId: string
  register: (key: string, node: HTMLElement | null) => void
  onRemove: () => void
}

function QueueRow({
  item,
  index,
  bestGuess,
  playBestGuesses,
  dragging,
  sliding,
  style,
  handleProps,
  hintId,
  register,
  onRemove,
}: RowProps) {
  const { track } = item
  const label = reviewLabel(item, bestGuess, playBestGuesses)
  const length = duration(track)
  const play = () => {
    // Playing a song that needs review is the explicit action its best guess waits for.
    if (bestGuess !== undefined && label === 'Needs review') playBestGuess(item, index, bestGuess)
    else void getPlayer().play(index)
  }
  return (
    <li
      style={style}
      className={cn(
        'flex items-center gap-1 rounded-lg',
        dragging && 'bg-elevated shadow-lg',
        // Only during a drag: on drop the rows take their new places without sliding back.
        sliding && !dragging && 'transition-transform duration-200 ease-standard',
      )}
    >
      <button
        type="button"
        ref={(node) => register(`handle:${item.uid}`, node)}
        aria-label={`Move ${track.title}`}
        aria-describedby={hintId}
        {...handleProps}
        className={iconButtonClasses({
          size: 'sm',
          className: 'cursor-grab touch-none active:cursor-grabbing',
        })}
      >
        <GripVertical />
      </button>
      <button
        type="button"
        onClick={play}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-1.5 pr-1 text-left hover:bg-text/5"
      >
        <TrackArtwork
          images={track.artwork}
          seed={track.id}
          size={44}
          rounded="sm"
          lazy
          className="size-11"
        />
        <span className="min-w-0 flex-1">
          <span className="sr-only">Play </span>
          <span className="block truncate font-semibold">{track.title}</span>
          <span className="block truncate text-sm text-text-muted">{byline(track)}</span>
          {label !== undefined && <ReviewMark label={label} />}
        </span>
      </button>
      {length !== undefined && (
        <span className="hidden w-10 shrink-0 text-right text-xs text-text-muted tabular-nums xs:block">
          {length}
        </span>
      )}
      <button
        type="button"
        ref={(node) => register(`remove:${item.uid}`, node)}
        aria-label={`Remove ${track.title} from the queue`}
        onClick={onRemove}
        className={iconButtonClasses({ size: 'sm' })}
      >
        <X />
      </button>
    </li>
  )
}

/** The songs after the current one, in play order, to reorder by dragging or with the keys. */
function UpNext({
  items,
  offset,
  context,
  announce,
}: {
  items: readonly QueueItem[]
  /** The queue index of the first item. */
  offset: number
  context: QueueContext | undefined
  /** Tells screen readers what happened. */
  announce: (message: string) => void
}) {
  const entries = useQueueReviewStore((state) => state.entries)
  const playBestGuesses = useQueueReviewStore((state) => state.playBestGuesses)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const listRef = useRef<HTMLOListElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const controls = useRef(new Map<string, HTMLElement>())
  const pendingFocus = useRef<string | null>(null)
  const headingId = useId()
  const hintId = useId()
  const visible = items.slice(0, limit)

  const { drag, handleProps, rowStyle } = useDragReorder({
    listRef,
    count: visible.length,
    rowsKey: items,
    onMove: (from, to, via) => {
      const item = items[from]
      if (item === undefined) return
      getPlayer().move(offset + from, offset + to)
      if (via === 'keyboard') pendingFocus.current = `handle:${item.uid}`
      announce(`Moved ${item.track.title} to position ${to + 1} of ${items.length}.`)
    },
  })

  // A moved or removed row loses focus when React moves its element: put focus back.
  useLayoutEffect(() => {
    const key = pendingFocus.current
    if (key === null) return
    pendingFocus.current = null
    const target = key === 'heading' ? headingRef.current : controls.current.get(key)
    target?.focus()
  })

  const register = (key: string, node: HTMLElement | null) => {
    if (node === null) controls.current.delete(key)
    else controls.current.set(key, node)
  }

  const remove = (position: number) => {
    const item = items[position]
    if (item === undefined) return
    const neighbour = items[position + 1] ?? items[position - 1]
    pendingFocus.current = neighbour === undefined ? 'heading' : `remove:${neighbour.uid}`
    getPlayer().remove(offset + position)
    announce(`Removed ${item.track.title} from the queue.`)
  }

  return (
    <section aria-labelledby={headingId}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={headingId} ref={headingRef} tabIndex={-1} className={SECTION_HEADING}>
            Next up
          </h3>
          {context !== undefined && <PlayingFrom context={context} />}
        </div>
        {items.length > 0 && (
          <button
            type="button"
            aria-label="Clear the songs up next"
            className={buttonClasses({ variant: 'ghost', className: 'h-touch px-3 lg:h-9' })}
            onClick={() => {
              pendingFocus.current = 'heading'
              getPlayer().clearUpcoming()
              announce('Cleared the songs up next.')
            }}
          >
            Clear
          </button>
        )}
      </div>
      <p id={hintId} className="sr-only">
        Press the up or down arrow key to move it, or Home or End to move it to the top or the
        bottom.
      </p>
      {items.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-text-muted">
          Nothing up next. Songs you add with “Play next” or “Add to queue” show up here.
        </p>
      ) : (
        <ol ref={listRef} className="mt-2 space-y-0.5">
          {visible.map((item, position) => (
            <QueueRow
              key={item.uid}
              item={item}
              index={offset + position}
              bestGuess={entries[item.track.id]}
              playBestGuesses={playBestGuesses}
              dragging={drag?.from === position}
              sliding={drag !== null}
              style={rowStyle(position)}
              handleProps={handleProps(position)}
              hintId={hintId}
              register={register}
              onRemove={() => remove(position)}
            />
          ))}
        </ol>
      )}
      {items.length > visible.length && (
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary', className: 'mt-3 w-full' })}
          onClick={() => setLimit(items.length)}
        >
          Show all {items.length} songs
        </button>
      )}
    </section>
  )
}

/** The "Play best guesses" setting. */
function BestGuessesSetting() {
  const playBestGuesses = useQueueReviewStore((state) => state.playBestGuesses)
  const setPlayBestGuesses = useQueueReviewStore((state) => state.setPlayBestGuesses)
  return (
    <Switch
      label="Play best guesses"
      description="Play songs from other catalogs even when FXM isn’t sure it found the right recording. Off: the queue skips them until you review them."
      checked={playBestGuesses}
      onChange={setPlayBestGuesses}
      className="rounded-xl border border-border p-4"
    />
  )
}

/**
 * The queue tab of Now playing: the current song, the songs up next (drag them, or use the
 * arrow keys on their handles, to reorder), the songs whose match needs review, and the "Play
 * best guesses" setting.
 */
export function QueuePanel() {
  const queue = usePlayerState((state) => state.queue)
  const entries = useQueueReviewStore((state) => state.entries)
  const playBestGuesses = useQueueReviewStore((state) => state.playBestGuesses)
  const [reviewing, setReviewing] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const nowPlayingRef = useRef<HTMLHeadingElement>(null)
  const focusNowPlaying = useRef(false)
  const nowPlayingId = useId()
  const current = queue.items[queue.index]
  // The same array until the queue changes, so a drag survives unrelated renders.
  const upcoming = useMemo(() => queue.items.slice(queue.index + 1), [queue.items, queue.index])
  const reviewCount = new Set(
    queue.items.flatMap((item) => (entries[item.track.id] === undefined ? [] : [item.track.id])),
  ).size

  // The review notice is gone once nothing needs review: don't leave focus on nothing.
  useLayoutEffect(() => {
    if (!focusNowPlaying.current) return
    focusNowPlaying.current = false
    nowPlayingRef.current?.focus()
  })

  const approveAll = () => {
    approveAllBestGuesses()
    setAnnouncement(
      reviewCount === 1 ? 'Approved 1 best guess.' : `Approved ${reviewCount} best guesses.`,
    )
    focusNowPlaying.current = true
  }

  return (
    <div className="space-y-6">
      {current === undefined ? (
        <EmptyState
          icon={ListMusic}
          title="Your queue is empty"
          description="Play an album, a playlist or a song, and what comes next shows up here."
          headingLevel={3}
          className="py-10"
          action={
            <Link to="/search" className={buttonClasses({ variant: 'secondary' })}>
              Find something to play
            </Link>
          }
        />
      ) : (
        <>
          {reviewCount > 0 && (
            <ReviewNotice
              count={reviewCount}
              playBestGuesses={playBestGuesses}
              onApproveAll={approveAll}
              onReview={() => setReviewing(true)}
            />
          )}
          <section aria-labelledby={nowPlayingId}>
            <h3
              id={nowPlayingId}
              ref={nowPlayingRef}
              tabIndex={-1}
              className={cn(SECTION_HEADING, 'mb-2')}
            >
              Now playing
            </h3>
            <CurrentRow item={current} />
          </section>
          <UpNext
            items={upcoming}
            offset={queue.index + 1}
            context={queue.context}
            announce={setAnnouncement}
          />
        </>
      )}
      <BestGuessesSetting />
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <ReviewDialog
        open={reviewing}
        onClose={() => {
          setReviewing(false)
          // Closing gives focus back to "Review", unless approving removed it with the notice.
          if (document.activeElement === null || document.activeElement === document.body) {
            nowPlayingRef.current?.focus()
          }
        }}
      />
    </div>
  )
}
