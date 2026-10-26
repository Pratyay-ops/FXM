import type { QueueItem, Track } from '@fxm/core'
import { ListMusic, MicVocal } from 'lucide-react'
import { Fragment, useId, useLayoutEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Artwork } from '../../components/ui/artwork'
import { buttonClasses } from '../../components/ui/button'
import { PageTitle } from '../../components/ui/page'
import { type TabItem, TabPanel, Tabs } from '../../components/ui/tabs'
import { DownloadButton } from '../downloads/download-button'
import { LyricsPanel } from '../lyrics/lyrics-panel'
import { LikeButton, PlayerControls, SeekBar } from '../player/controls'
import { QueuePanel } from '../queue/queue-panel'
import { InlineSkipNotice } from '../sponsorblock/sponsorblock-notices'
import { entityPath } from './browse-links'
import { useCurrentItem } from './playback'
import { PlaybackProblem } from './playback-problem'
import { scrollBehavior } from './scroll'
import { StreamInfo } from './stream-info'
import { KIND_LABELS } from './stream-label'
import { TrackArtwork } from './track-artwork'

type Panel = 'lyrics' | 'queue'

const PANELS: readonly TabItem<Panel>[] = [
  { value: 'lyrics', label: 'Lyrics' },
  { value: 'queue', label: 'Queue' },
]

const PANEL_ICONS = { lyrics: MicVocal, queue: ListMusic } as const

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
 * The track column. `min-w-0` lets long titles and credits truncate instead of widening the
 * page. From 768px its width (and so the cover's) also keeps the cover, the title and the stream
 * badge between the top bar and the player bar, on a laptop screen too.
 */
const TRACK_COLUMN =
  'mx-auto w-full min-w-0 max-w-sm md:max-w-[min(28rem,max(16rem,calc(100dvh-var(--shell-top)-var(--shell-bottom)-17rem)))]'

/**
 * The cover's size: the column's width, and on phones at most about half the screen's height,
 * so the controls under it stay in view.
 */
const COVER = 'mx-auto aspect-square w-full shadow-xl max-md:max-w-[min(100%,46dvh)]'

function CurrentTrack({ item, headingId }: { item: QueueItem; headingId: string }) {
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
          {/* Focusable for the moments a control it replaced had the focus. */}
          <h2
            id={headingId}
            tabIndex={-1}
            className="line-clamp-2 text-2xl font-bold tracking-tight break-words"
          >
            {track.title}
          </h2>
          <Byline track={track} />
        </div>
        <DownloadButton track={track} size="md" />
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

/** Phones: Lyrics and Queue under the controls, each bringing its panel up from below. */
function PanelShortcuts({ onShow }: { onShow: (panel: Panel) => void }) {
  return (
    <div className="mt-2 flex justify-between">
      {PANELS.map(({ value, label }) => {
        const Icon = PANEL_ICONS[value]
        return (
          <button
            key={value}
            type="button"
            className={buttonClasses({ variant: 'ghost', className: 'px-3' })}
            onClick={() => onShow(value)}
          >
            <Icon aria-hidden="true" />
            {label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Now playing: the track (cover, title, stream badge and, on phones, the controls) next to the
 * lyrics and the queue, which phones show under the track. On phones it fills the screen: the
 * app layout hides the tab bar and the mini player here, and the top bar's back arrow leaves.
 */
export function NowPlayingPage() {
  const [params, setParams] = useSearchParams()
  const panel: Panel = params.get('tab') === 'queue' ? 'queue' : 'lyrics'
  const tabsId = useId()
  const headingId = useId()
  const panels = useRef<HTMLElement>(null)
  // The panel a shortcut asked for, to bring into view once it shows.
  const reveal = useRef<Panel | null>(null)
  const item = useCurrentItem()

  const select = (next: Panel) =>
    setParams(next === 'queue' ? { tab: 'queue' } : {}, { replace: true, preventScrollReset: true })

  /** Scrolls the panels up under the top bar and puts the focus on the selected tab. */
  const revealPanels = () => {
    const section = panels.current
    if (section === null) return
    section.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
    section
      .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    if (reveal.current !== panel) return
    reveal.current = null
    revealPanels()
  })

  const show = (next: Panel) => {
    if (next === panel) {
      revealPanels()
      return
    }
    reveal.current = next
    select(next)
  }

  return (
    <div className="pt-2 md:pt-4">
      {/* The track's title leads the page. On phones the top bar shows the page's name. */}
      <PageTitle className="sr-only">Now playing</PageTitle>
      <div className="grid gap-8 md:grid-cols-2 md:gap-10 xl:gap-16">
        <section aria-label="Track" className={TRACK_COLUMN}>
          {item === undefined ? (
            <NothingPlaying />
          ) : (
            <CurrentTrack item={item} headingId={headingId} />
          )}
          {/* Phones get the controls under the title; from 768px the player bar has them. */}
          <div className="mt-4 md:hidden">
            <SeekBar />
            <PlayerControls size="lg" className="mt-3" />
            <PanelShortcuts onShow={show} />
            {/* SponsorBlock's skip notice (stage 8.7): here it covers none of the controls, and
                coming after the shortcuts, it moves none of them when it appears. */}
            <InlineSkipNotice />
          </div>
          <PlaybackProblem />
          {/* Keyed by item: a new track closes the details and the version switcher. */}
          {item !== undefined && <StreamInfo key={item.uid} item={item} headingId={headingId} />}
        </section>

        <section ref={panels} aria-label="Lyrics and queue" className="min-w-0">
          <Tabs
            label="Now playing panels"
            items={PANELS}
            value={panel}
            onChange={select}
            id={tabsId}
          />
          <TabPanel id={tabsId} value={panel} className="mt-4">
            {panel === 'lyrics' ? <LyricsPanel /> : <QueuePanel />}
          </TabPanel>
        </section>
      </div>
    </div>
  )
}
