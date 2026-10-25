import type { DailyMix, HomeShelf, QueueContext } from '@fxm/core'
import { isEntityId } from '@fxm/core'
import { ExternalLink, Plug, RotateCw, Search, SlidersHorizontal } from 'lucide-react'
import { useId, useState } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { Dialog } from '../library/ui/dialog'
import { CATALOG_MODE_LABELS } from '../settings/options'
import { useSettingsStore } from '../settings/settings-store'
import { HomeSkeleton } from './home-skeleton'
import { TasteOnboarding, TasteReminder } from './onboarding'
import { canRecommend, type HomePlayback, useHomeReach, useHomeServices } from './services'
import {
  MixRow,
  MixTrackList,
  mixArtists,
  PlayAllButton,
  playFrom,
  QuickPicksGrid,
  ShelfSection,
  SourceRow,
  TrackRow,
} from './shelves'
import { useTasteStore } from './taste-store'
import { useHomeFeed } from './use-home-feed'

/**
 * Where to get FXM Connect, the desktop app or the Android app: the landing page's "Get FXM"
 * section, until stage 2.7 builds the in-app onboarding (2.4's `ONBOARDING_URL`).
 */
export const GET_FXM_URL = 'https://fxmusic.pages.dev/#get'

/** The line under each kind of shelf. */
const DESCRIPTIONS: Partial<Record<HomeShelf['type'], string>> = {
  'quick-picks': 'Songs for right now, from what you play and what sounds like it.',
  'daily-mixes': 'Your favourite artists, mixed with new finds. New every day.',
  discover: 'New songs for you, by artists you hardly know. New every Monday.',
  'on-repeat': 'The songs you have played most lately.',
  rediscover: 'Songs you loved a while ago.',
}

function WelcomeCard() {
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className="overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-lg sm:p-7"
      style={{
        backgroundImage:
          'radial-gradient(90% 120% at 100% 0%, color-mix(in oklab, var(--color-accent) 22%, transparent), transparent 70%)',
      }}
    >
      <div className="max-w-xl">
        <p className="text-xs font-bold tracking-[0.14em] text-accent uppercase">
          {CATALOG_MODE_LABELS[catalogMode]} mode
        </p>
        <h2 id={titleId} className="mt-2 text-2xl font-extrabold tracking-tight sm:text-3xl">
          Play practically any song
        </h2>
        <p className="mt-2 text-text-muted">
          {catalogMode === 'music'
            ? 'Clean album audio from the YouTube Music catalog. Switch to Music + Video for covers, live sets and remixes.'
            : 'Songs plus any YouTube video – covers, live sets, remixes – all played as music.'}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link to="/search" className={buttonClasses()}>
            <Search aria-hidden="true" />
            Search music
          </Link>
          <Link to="/settings" className={buttonClasses({ variant: 'secondary' })}>
            <SlidersHorizontal aria-hidden="true" />
            Change mode
          </Link>
        </div>
      </div>
    </section>
  )
}

/** Why there are no recommendations in the Free-only tier, and how to get them. */
function RecommendationsNote() {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="flex flex-1 items-start gap-3">
        <Plug aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-text-muted" />
        <div className="space-y-0.5">
          <h2 id={headingId} className="text-sm font-semibold">
            Recommendations need YouTube Music
          </h2>
          <p className="text-sm text-text-muted">
            FXM finds new music for you on YouTube Music, through the free FXM Connect browser
            extension or the desktop and Android apps. Until then, Home shows what you play.
          </p>
        </div>
      </div>
      <div className="pl-8 sm:pl-0">
        <a href={GET_FXM_URL} target="_blank" rel="noreferrer" className={buttonClasses()}>
          Get FXM Connect
          <ExternalLink aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </div>
    </section>
  )
}

/** Where a shelf's songs play from, as the queue shows it ("Playing from …"). */
function contextOf(shelf: HomeShelf): QueueContext {
  const seed = shelf.type === 'because' ? shelf.seed.id : undefined
  if (isEntityId(seed, 'track') || isEntityId(seed, 'artist')) {
    return { type: 'radio', seed, title: shelf.title }
  }
  return { type: 'library', id: `home:${shelf.id}`, title: shelf.title }
}

/** One shelf of Home. */
function HomeShelfView({
  shelf,
  playback,
  onOpenMix,
}: {
  shelf: HomeShelf
  playback: HomePlayback | undefined
  onOpenMix: (mix: DailyMix) => void
}) {
  const description = DESCRIPTIONS[shelf.type]
  switch (shelf.type) {
    case 'daily-mixes':
      return (
        <ShelfSection title={shelf.title} description={description}>
          <MixRow mixes={shelf.mixes} onOpen={onOpenMix} />
        </ShelfSection>
      )
    case 'source': {
      const tracks = shelf.shelf.items.flatMap((item) =>
        item.type === 'track' ? [item.track] : [],
      )
      return (
        <ShelfSection
          title={shelf.title}
          description={shelf.subtitle ?? 'From your Spotify account.'}
        >
          <SourceRow
            label={shelf.title}
            items={shelf.shelf.items}
            play={playFrom(playback, tracks, contextOf(shelf))}
          />
        </ShelfSection>
      )
    }
    default: {
      const tracks = shelf.items.map((item) => item.track)
      const play = playFrom(playback, tracks, contextOf(shelf))
      return (
        <ShelfSection
          title={shelf.title}
          description={description}
          action={
            shelf.type === 'quick-picks' ? undefined : (
              <PlayAllButton play={play} label={`Play ${shelf.title}`} />
            )
          }
        >
          {shelf.type === 'quick-picks' ? (
            <QuickPicksGrid items={shelf.items} play={play} />
          ) : (
            <TrackRow label={shelf.title} items={shelf.items} play={play} />
          )}
        </ShelfSection>
      )
    }
  }
}

/** A Daily Mix's songs, with Play. */
function MixDialog({
  mix,
  playback,
  onClose,
}: {
  mix: DailyMix | null
  playback: HomePlayback | undefined
  onClose: () => void
}) {
  const play =
    mix === null
      ? undefined
      : playFrom(
          playback,
          mix.tracks.map((item) => item.track),
          { type: 'library', id: `home:${mix.id}`, title: mix.title },
        )
  return (
    <Dialog
      open={mix !== null}
      onClose={onClose}
      title={mix?.title ?? ''}
      description={mix === null ? undefined : mixArtists(mix)}
      className="w-[min(36rem,calc(100%-2rem))]"
    >
      {mix !== null && (
        <div className="space-y-4">
          {play !== undefined && (
            <button
              type="button"
              onClick={() => {
                play(0)
                onClose()
              }}
              className={buttonClasses()}
            >
              Play {mix.title}
            </button>
          )}
          <MixTrackList
            mix={mix}
            play={
              play === undefined
                ? undefined
                : (index) => {
                    play(index)
                    onClose()
                  }
            }
          />
        </div>
      )}
    </Dialog>
  )
}

/**
 * Everything on Home below the greeting: the notes, the onboarding and the shelves. A lazy chunk
 * of its own, so the library database and the recommendation engine load after the page shows.
 */
export function HomeContent() {
  const services = useHomeServices()
  const reach = useHomeReach(services)
  const feed = useHomeFeed()
  const dismissed = useTasteStore((state) => state.dismissedAt !== undefined)
  const [openMix, setOpenMix] = useState<DailyMix | null>(null)
  const recommending = canRecommend(services, reach)
  const data = feed.data
  const coldStart = recommending && data?.coldStart === true
  const shelves = data?.shelves ?? []

  return (
    <>
      {reach.capabilities.youtube === 'none' && <RecommendationsNote />}
      {coldStart && (dismissed ? <TasteReminder /> : <TasteOnboarding />)}

      {feed.status === 'pending' && <HomeSkeleton />}
      {feed.status === 'error' && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-surface p-4"
        >
          <p className="flex-1 text-sm">Home couldn't read your library.</p>
          <button
            type="button"
            onClick={() => void feed.refetch()}
            className={buttonClasses({ variant: 'secondary' })}
          >
            <RotateCw aria-hidden="true" />
            Try again
          </button>
        </div>
      )}
      {shelves.map((shelf) => (
        <HomeShelfView
          key={shelf.id}
          shelf={shelf}
          playback={services.playback}
          onOpenMix={setOpenMix}
        />
      ))}
      {feed.status === 'success' && shelves.length === 0 && !coldStart && <WelcomeCard />}

      <MixDialog mix={openMix} playback={services.playback} onClose={() => setOpenMix(null)} />
    </>
  )
}
