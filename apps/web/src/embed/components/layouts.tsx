import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'
import { type EmbedView, kindNameOf } from '../view'
import {
  AttributionLine,
  BrandLink,
  CompactCredits,
  Cover,
  type EmbedActions,
  MessageAction,
  MessageText,
  PlayButton,
  ProgressLine,
  SeekBar,
  SkipButtons,
  TrackList,
} from './parts'

interface LayoutProps {
  view: EmbedView
  actions: EmbedActions | undefined
  /** Whether the title is the page's heading (the embed) or plain text (the preview). */
  heading: boolean
}

/** The second line of the compact layout: the artists, and what the track plays from. */
function compactSubtitle(view: EmbedView): string {
  if (view.now === undefined) return view.subtitle ?? ''
  if (view.kind === 'track') return view.now.artists
  return [view.now.artists, view.title].filter(Boolean).join(' · ')
}

/**
 * The compact layout's second line, with a free-source track's credits after the artists. The
 * artists and the provider share what room there is, so neither disappears, and the licence
 * icon stays whole.
 */
function CompactSubtitle({ view }: { view: EmbedView }) {
  const text = compactSubtitle(view)
  if (view.attribution === undefined) {
    return <p className="truncate text-xs text-text-muted">{text}</p>
  }
  return (
    <p className="flex min-w-0 items-center gap-1 text-xs whitespace-nowrap text-text-muted">
      {text && (
        <>
          <span className="min-w-0 truncate">{text}</span>
          <span aria-hidden="true" className="shrink-0">
            ·
          </span>
        </>
      )}
      <CompactCredits view={view} />
    </p>
  )
}

/**
 * One row, 80 px high: the artwork, the title and artists with a progress line, skip buttons
 * on wider players, the play button and the FXM mark. A message takes the second line in few
 * words, and the mark's place goes to the room it needs: its action, where there is one, is an
 * icon button on narrow players and takes the play button's place when nothing can play.
 */
function CompactLayout({ view, actions, heading }: LayoutProps) {
  const title = view.now?.title ?? view.title
  const message = view.message
  return (
    <div className="flex h-full items-center gap-3 py-2 pr-4 pl-2">
      {heading && view.title !== undefined && <h1 className="sr-only">{view.title}</h1>}
      {view.loading ? (
        <Skeleton className="size-16 shrink-0 rounded-md" />
      ) : (
        <Cover view={view} pixels={64} rounded="md" className="size-16" />
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        {view.loading ? (
          <>
            <Skeleton className="h-4 w-3/4 rounded-full" />
            <Skeleton className="h-3 w-1/2 rounded-full" />
          </>
        ) : (
          <>
            {title !== undefined && (
              // The same words as the hidden heading are read once, from the heading.
              <p
                aria-hidden={(heading && title === view.title) || undefined}
                className="truncate text-sm font-semibold"
              >
                {title}
              </p>
            )}
            {message === undefined && <CompactSubtitle view={view} />}
          </>
        )}
        {/* A live region from the first render, empty and hidden without a message. */}
        <div role="status" className="empty:hidden">
          {message !== undefined && (
            <MessageText view={view} short className="line-clamp-2 text-xs" />
          )}
        </div>
        {view.canPlay && message === undefined && (
          <div className="mt-0.5">
            <ProgressLine view={view} />
          </div>
        )}
      </div>
      {view.loading ? (
        // Where the play button will be, so nothing moves when it comes.
        <Skeleton className="size-touch shrink-0 rounded-full" />
      ) : view.canPlay ? (
        <>
          <div className="hidden @min-[25rem]:contents">
            <SkipButtons view={view} actions={actions} />
          </div>
          <PlayButton view={view} actions={actions} size="md" />
        </>
      ) : (
        <MessageAction view={view} actions={actions} layout="compact" />
      )}
      {message === undefined && <BrandLink view={view} className="self-start" />}
    </div>
  )
}

/**
 * The card's controls: the play button, the seek bar (with what plays above it, in an album or
 * a playlist) and the skip buttons. A message takes the seek bar's place, next to the play
 * button when something can play, with its action at the end. Below 25rem, a collection's
 * seek bar gets a line of its own under the buttons.
 */
function CardControls({ view, actions }: Omit<LayoutProps, 'heading'>) {
  const message = view.message
  const collection = view.kind !== 'track'
  const showNow = collection && view.now !== undefined && view.status !== 'idle'
  const controls = !view.loading && view.canPlay
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
      {view.loading && (
        // Where the play button and the seek bar will be, so nothing moves when they come.
        <>
          <Skeleton className="size-12 shrink-0 rounded-full" />
          <Skeleton className="h-2 min-w-0 flex-1 rounded-full" />
        </>
      )}
      {controls && <PlayButton view={view} actions={actions} size="lg" />}
      {controls && message === undefined && (
        <>
          {/* Narrow collections: a box only from 25rem; below, its parts join the row. */}
          <div
            className={
              collection
                ? 'contents @min-[25rem]:block @min-[25rem]:min-w-0 @min-[25rem]:flex-1'
                : 'min-w-0 flex-1'
            }
          >
            {showNow && view.now !== undefined && (
              <p
                className={cn(
                  'truncate px-1 text-xs',
                  collection && 'min-w-0 flex-1 @min-[25rem]:flex-none',
                )}
              >
                <span className="font-semibold">{view.now.title}</span>
                {view.now.artists && <span className="text-text-muted"> · {view.now.artists}</span>}
              </p>
            )}
            <div
              className={cn(
                collection &&
                  'order-last basis-full @min-[25rem]:order-none @min-[25rem]:basis-auto',
              )}
            >
              <SeekBar view={view} actions={actions} />
            </div>
          </div>
          <SkipButtons view={view} actions={actions} className="ml-auto" />
        </>
      )}
      {/* The same live region from the first render: empty, and hidden, without a message. */}
      <div role="status" className="min-w-0 flex-1 empty:hidden">
        {message !== undefined && (
          <MessageText view={view} short={view.canPlay} className="text-sm" />
        )}
      </div>
      {message !== undefined && <MessageAction view={view} actions={actions} layout="card" />}
    </div>
  )
}

/** "Album · 12 songs", or just "Album" below 20rem, where the count would wrap the line. */
function KindLabel({ view }: { view: EmbedView }) {
  const name = kindNameOf(view.kind)
  if (view.kindLabel === name) return name
  return (
    <>
      <span className="@min-[20rem]:hidden">{name}</span>
      <span className="hidden @min-[20rem]:inline">{view.kindLabel}</span>
    </>
  )
}

/**
 * A card: the artwork with the title, the controls with a seek bar, and for albums and
 * playlists the track list. A track's card is 232 px high: its cover shrinks while a message
 * shows, so the tallest message still fits.
 */
function CardLayout({ view, actions, heading }: LayoutProps) {
  const Title = heading ? 'h1' : 'p'
  // A track's card has no list, so its cover gets the room, unless a message needs it.
  const cover =
    view.kind === 'track' && view.message === undefined
      ? { pixels: 120, size: 'size-30' }
      : { pixels: 96, size: 'size-24' }
  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <header className="flex shrink-0 items-start gap-3">
        {view.loading ? (
          <Skeleton className={cn(cover.size, 'shrink-0 rounded-lg')} />
        ) : (
          <Cover view={view} pixels={cover.pixels} rounded="lg" className={cover.size} />
        )}
        <div className="min-w-0 flex-1 pt-0.5">
          {view.loading ? (
            <>
              <Skeleton className="h-3 w-16 rounded-full" />
              <Skeleton className="mt-3 h-5 w-4/5 rounded-full" />
              <Skeleton className="mt-2 h-4 w-1/2 rounded-full" />
            </>
          ) : (
            <>
              <p className="text-2xs font-bold tracking-[0.12em] text-text-muted uppercase">
                <KindLabel view={view} />
              </p>
              {view.title !== undefined && (
                <Title className="mt-1 line-clamp-2 text-lg leading-tight font-bold">
                  {view.title}
                </Title>
              )}
              {view.subtitle ? (
                <p className="mt-1 truncate text-sm text-text-muted">{view.subtitle}</p>
              ) : null}
            </>
          )}
        </div>
        <BrandLink view={view} />
      </header>
      <CardControls view={view} actions={actions} />
      {view.rows.length > 0 && <TrackList view={view} actions={actions} />}
      {view.placeholderRows !== undefined && <PlaceholderRows count={view.placeholderRows} />}
      {view.loading && view.kind !== 'track' && <PlaceholderRows count={4} />}
      <AttributionLine view={view} />
    </div>
  )
}

/** Rows standing in for a track list that isn't there: while loading, or in a preview. */
function PlaceholderRows({ count }: { count: number }) {
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-hidden px-2 pt-1">
      {Array.from({ length: count }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders, never reordered.
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-3 w-5 shrink-0 rounded-full" />
          <Skeleton className="h-3 flex-1 rounded-full" />
          <Skeleton className="h-3 w-8 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  )
}

/**
 * The player in its layout. `actions` drive it; without them (the share dialog's preview) it
 * only shows. The embed renders it as the page's `main`; the preview inside the app as a `div`.
 * Its parts adapt to its own width (a size container), not the window's, so the preview looks
 * like the iframe it previews.
 */
export function EmbedPlayerView({
  view,
  actions,
  as: Root = 'main',
  className,
}: {
  view: EmbedView
  actions?: EmbedActions
  as?: 'main' | 'div'
  className?: string
}) {
  // Only the embed's own page is a landmark with a name; the preview is a plain box.
  const landmark =
    Root === 'main'
      ? {
          'aria-label': view.title === undefined ? 'FXM player' : `FXM player: ${view.title}`,
          'aria-busy': view.loading || undefined,
        }
      : {}
  return (
    <Root
      {...landmark}
      className={cn('@container h-full overflow-hidden bg-surface text-text', className)}
    >
      {view.layout === 'compact' ? (
        <CompactLayout view={view} actions={actions} heading={Root === 'main'} />
      ) : (
        <CardLayout view={view} actions={actions} heading={Root === 'main'} />
      )}
    </Root>
  )
}
