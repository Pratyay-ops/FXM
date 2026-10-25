import { isFxmError, type QueueItem, type Track } from '@fxm/core'
import type { PlayerError } from '@fxm/player'
import { CircleAlert, ListMusic, RotateCcw } from 'lucide-react'
import { Fragment, useId } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Artwork } from '../../components/ui/artwork'
import { buttonClasses } from '../../components/ui/button'
import { PageTitle } from '../../components/ui/page'
import { Skeleton } from '../../components/ui/skeleton'
import { type TabItem, TabPanel, Tabs } from '../../components/ui/tabs'
import { LikeButton, PlayerControls, SeekBar } from '../player/controls'
import { entityPath } from './browse-links'
import { getPlayer, useCurrentItem, usePlayerState } from './playback'
import { StreamInfo } from './stream-info'
import { KIND_LABELS } from './stream-label'
import { TrackArtwork } from './track-artwork'

type Panel = 'lyrics' | 'queue'

const PANELS: readonly TabItem<Panel>[] = [
  { value: 'lyrics', label: 'Lyrics' },
  { value: 'queue', label: 'Queue' },
]

// Unique widths double as React keys.
const LYRIC_LINES = ['w-3/4', 'w-1/2', 'w-5/6', 'w-2/3', 'w-3/5', 'w-4/5', 'w-7/12', 'w-5/12']

function LyricsPlaceholder() {
  return (
    <div className="space-y-5">
      <p className="text-sm text-text-muted">Synced lyrics will scroll here as the song plays.</p>
      <div aria-hidden="true" className="space-y-4">
        {LYRIC_LINES.map((width) => (
          <Skeleton key={width} className={`h-6 rounded-full md:h-7 ${width}`} />
        ))}
      </div>
    </div>
  )
}

function QueuePlaceholder({ item }: { item: QueueItem | undefined }) {
  return (
    <div className="space-y-6">
      {item !== undefined && (
        <div>
          <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-text-muted uppercase">
            Now playing
          </h3>
          <div className="flex items-center gap-3 rounded-lg bg-elevated p-2">
            <TrackArtwork
              images={item.track.artwork}
              seed={item.track.id}
              size={48}
              rounded="sm"
              className="size-12"
            />
            <div className="min-w-0">
              <p className="truncate font-semibold text-accent">{item.track.title}</p>
              <p className="truncate text-sm text-text-muted">
                {item.track.artists.map((artist) => artist.name).join(', ')}
              </p>
            </div>
          </div>
        </div>
      )}
      <div>
        <h3 className="mb-2 text-xs font-bold tracking-[0.12em] text-text-muted uppercase">
          Next up
        </h3>
        <div className="flex flex-col items-center rounded-lg border border-dashed border-border px-4 py-10 text-center">
          <ListMusic aria-hidden="true" className="size-7 text-text-muted" strokeWidth={1.75} />
          <p className="mt-3 font-semibold">The queue panel comes next</p>
          <p className="mt-1 max-w-xs text-sm text-text-muted">
            Songs you add with “Play next” or “Add to queue” show up here.
          </p>
        </div>
      </div>
    </div>
  )
}

/** The artists, each linked to its page once those exist, after the kind of a video. */
function Byline({ track }: { track: Track }) {
  return (
    <p className="truncate text-text-muted">
      {track.kind !== 'song' && <>{KIND_LABELS[track.kind]} · </>}
      {track.artists.map((artist, index) => {
        const to = artist.id === undefined ? undefined : entityPath(artist.id)
        return (
          <Fragment key={`${artist.id ?? ''}:${artist.name}`}>
            {index > 0 && ', '}
            {to === undefined ? (
              artist.name
            ) : (
              <Link to={to} className="hover:text-text hover:underline">
                {artist.name}
              </Link>
            )}
          </Fragment>
        )
      })}
    </p>
  )
}

/**
 * The cover's size: the column's width, and on phones at most about half the screen's height,
 * so the controls under it stay in view.
 */
const COVER = 'mx-auto aspect-square w-full shadow-xl max-md:max-w-[min(100%,46dvh)]'

function CurrentTrack({ item }: { item: QueueItem }) {
  const { track } = item
  return (
    <>
      <TrackArtwork
        images={track.artwork}
        seed={track.id}
        size={448}
        rounded="xl"
        className={COVER}
      />
      <div className="mt-6 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 text-2xl font-bold tracking-tight break-words">
            {track.title}
          </h2>
          <Byline track={track} />
        </div>
        <LikeButton size="md" />
      </div>
    </>
  )
}

function NothingPlaying() {
  return (
    <>
      <Artwork seed="fxm-now-playing" rounded="xl" className={COVER} />
      <div className="mt-6">
        <h2 className="text-2xl font-bold tracking-tight">Nothing playing</h2>
        <p className="text-text-muted">
          Find a song in{' '}
          <Link to="/search" className="font-semibold text-text underline underline-offset-2">
            Search
          </Link>{' '}
          and it plays here.
        </p>
      </div>
    </>
  )
}

/** What went wrong, in words, with what the user can do about it. */
function describeProblem({ reason, error, item }: PlayerError): { title: string; text: string } {
  if (reason === 'circuit-open') {
    return {
      title: 'Playback stopped',
      text: 'Several songs in a row couldn’t play. Check your connection, then try again.',
    }
  }
  if (reason === 'action-required') {
    const code = isFxmError(error) ? error.code : undefined
    if (code === 'AuthRequired') {
      return { title: 'Sign-in needed', text: 'This song’s service wants you to sign in first.' }
    }
    if (code === 'BotCheck') {
      return {
        title: 'Playback paused by the source',
        text: 'The source wants to check that a person is listening. Wait a while, then try again.',
      }
    }
    return {
      title: 'This song can’t play here',
      text: 'This browser can’t reach its source. FXM Connect, the desktop app or the Android app can play more songs.',
    }
  }
  return {
    title: `Couldn’t play “${item.track.title}”`,
    text: 'It may be unavailable right now. Try again, or pick another song.',
  }
}

/** Why playback stopped, while it is stopped, with a way to try again. */
function PlaybackProblem() {
  const problem = usePlayerState((state) => state.error)
  if (problem === undefined) return null
  const { title, text } = describeProblem(problem)
  return (
    <div role="alert" className="mt-4 flex gap-3 rounded-xl bg-danger/12 p-4">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        <p className="mt-1 text-sm text-text-muted">{text}</p>
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary', className: 'mt-3 h-10 px-4' })}
          onClick={() => void getPlayer().play()}
        >
          <RotateCcw aria-hidden="true" />
          Try again
        </button>
      </div>
    </div>
  )
}

export function NowPlayingPage() {
  const [params, setParams] = useSearchParams()
  const panel: Panel = params.get('tab') === 'queue' ? 'queue' : 'lyrics'
  const tabsId = useId()
  const item = useCurrentItem()

  return (
    <div className="pt-2 md:space-y-8 md:pt-4">
      <PageTitle hideOnPhone>Now playing</PageTitle>
      <div className="grid gap-8 md:grid-cols-2 md:gap-10 xl:gap-16">
        <section aria-label="Track" className="mx-auto w-full max-w-sm md:max-w-md">
          {item === undefined ? <NothingPlaying /> : <CurrentTrack item={item} />}
          {/* Phones get the controls under the title; from 768px the player bar has them. */}
          <div className="mt-4 md:hidden">
            <SeekBar />
            <PlayerControls size="lg" className="mt-3" />
          </div>
          <PlaybackProblem />
          {/* Keyed by item: a new track closes the details and the version switcher. */}
          {item !== undefined && <StreamInfo key={item.uid} item={item} />}
        </section>

        <section aria-label="Lyrics and queue" className="min-w-0">
          <Tabs
            label="Now playing panels"
            items={PANELS}
            value={panel}
            onChange={(next) =>
              setParams(next === 'queue' ? { tab: 'queue' } : {}, {
                replace: true,
                preventScrollReset: true,
              })
            }
            id={tabsId}
          />
          <TabPanel id={tabsId} value={panel} className="mt-4">
            {panel === 'lyrics' ? <LyricsPlaceholder /> : <QueuePlaceholder item={item} />}
          </TabPanel>
        </section>
      </div>
    </div>
  )
}
