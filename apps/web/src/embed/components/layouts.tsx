import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'
import type { EmbedView } from '../view'
import {
  AttributionLine,
  BrandLink,
  Cover,
  type EmbedActions,
  MessageBlock,
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
 * One row, 80 px high: the artwork, the title and artists with a progress line, skip buttons
 * on wider players, the play button and the FXM mark.
 */
function CompactLayout({ view, actions, heading }: LayoutProps) {
  const title = view.now?.title ?? view.title
  return (
    <div className="flex h-full items-center gap-3 py-2 pr-2 pl-2">
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
            {title !== undefined && <p className="truncate text-sm font-semibold">{title}</p>}
            <div role="status" className="min-w-0">
              {view.message === undefined ? (
                <>
                  <p className="truncate text-xs text-text-muted">{compactSubtitle(view)}</p>
                  {view.canPlay && (
                    <div className="mt-1.5">
                      <ProgressLine view={view} />
                    </div>
                  )}
                </>
              ) : (
                <MessageBlock view={view} actions={actions} compact />
              )}
            </div>
          </>
        )}
      </div>
      {view.canPlay && (
        <>
          <SkipButtons view={view} actions={actions} className="hidden xs:flex" />
          <PlayButton view={view} actions={actions} size="md" />
        </>
      )}
      <BrandLink view={view} className="self-start" />
    </div>
  )
}

/**
 * A card: the artwork with the title, the controls with a seek bar, and for albums and
 * playlists the track list.
 */
function CardLayout({ view, actions, heading }: LayoutProps) {
  const Title = heading ? 'h1' : 'p'
  const showNow = view.kind !== 'track' && view.now !== undefined && view.status !== 'idle'
  // A track's card has no list, so its cover gets the room.
  const cover =
    view.kind === 'track' ? { pixels: 120, size: 'size-30' } : { pixels: 96, size: 'size-24' }
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
                {view.kindLabel}
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
      {view.canPlay && (
        <div className="flex shrink-0 items-center gap-2">
          <PlayButton view={view} actions={actions} size="lg" />
          <div className="min-w-0 flex-1">
            {showNow && view.now !== undefined && (
              <p className="truncate px-1 text-xs">
                <span className="font-semibold">{view.now.title}</span>
                {view.now.artists && <span className="text-text-muted"> · {view.now.artists}</span>}
              </p>
            )}
            <SeekBar view={view} actions={actions} />
          </div>
          <SkipButtons view={view} actions={actions} />
        </div>
      )}
      <div role="status" className="shrink-0 empty:hidden">
        {view.message !== undefined && <MessageBlock view={view} actions={actions} />}
      </div>
      {view.rows.length > 0 && <TrackList view={view} actions={actions} />}
      {view.placeholderRows !== undefined && <PlaceholderRows count={view.placeholderRows} />}
      <AttributionLine view={view} />
    </div>
  )
}

/** Rows standing in for a track list the share dialog's preview doesn't have. */
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
  return (
    <Root
      aria-label={view.title === undefined ? 'FXM player' : `FXM player: ${view.title}`}
      aria-busy={view.loading || undefined}
      className={cn('h-full overflow-hidden bg-surface text-text', className)}
    >
      {view.layout === 'compact' ? (
        <CompactLayout view={view} actions={actions} heading={Root === 'main'} />
      ) : (
        <CardLayout view={view} actions={actions} heading={Root === 'main'} />
      )}
    </Root>
  )
}
