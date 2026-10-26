import type { DailyMix, HomeShelf, PickedArtist, QueueContext } from '@fxm/core'
import { isEntityId } from '@fxm/core'
import { Plug, RotateCw, Search, SlidersHorizontal } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { canAddConnect, currentDevice, type DeviceInfo } from '../connect/device'
import {
  canGetMoreHere,
  connectExtensionOrApps,
  getMoreLabel,
  howToGetMore,
} from '../connect/explain'
import { showStatus } from '../library/status'
import { Dialog } from '../library/ui/dialog'
import { ONBOARDING_URL } from '../search/onboarding'
import { CATALOG_MODE_LABELS } from '../settings/options'
import { useSettingsStore } from '../settings/settings-store'
import { HomeSkeleton } from './home-skeleton'
import { TasteOnboarding, TastePicksSection, TasteReminder } from './onboarding'
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
 * Where to get FXM Connect (and the apps, once they are out): the in-app onboarding of stage
 * 2.7, the same page as search's entry point (2.4's `ONBOARDING_URL`).
 */
export const GET_FXM_URL = ONBOARDING_URL

/** The line under each kind of shelf. */
const DESCRIPTIONS: Partial<Record<HomeShelf['type'], string>> = {
  'quick-picks': 'Songs for right now, from what you play and what sounds like it.',
  'daily-mixes': 'Your favourite artists, mixed with new finds. New every day.',
  discover: 'New songs for you, by artists you hardly know. New every Monday.',
  'on-repeat': 'The songs you have played most lately.',
  rediscover: 'Songs you loved a while ago.',
}

/**
 * The in-app onboarding: "Get FXM Connect" where this device can get it, else "See your options"
 * (iPhone and iPad, Android until its app is out), where the page says what works there.
 */
function GetConnectLink({
  variant,
  device,
}: {
  variant: 'primary' | 'secondary'
  device: DeviceInfo
}) {
  return (
    <Link to={GET_FXM_URL} className={buttonClasses({ variant })}>
      <Plug aria-hidden="true" />
      {getMoreLabel(device)}
    </Link>
  )
}

/**
 * What Home says about getting YouTube Music, which its recommendations need, after what it
 * `brings`: FXM Connect where this browser can add it, else what this device can do instead
 * (another browser on a Mac, nothing on iPhone and iPad).
 */
function getYouTubeText(device: DeviceInfo, brings: string): string {
  if (canAddConnect(device)) {
    return `${brings}, with ${connectExtensionOrApps()}. Until then, Home shows what you play.`
  }
  const meanwhile = canGetMoreHere(device) ? 'Until then' : 'Here'
  return `${brings}. ${howToGetMore(device, 'youtube')} ${meanwhile}, Home shows what you play.`
}

/**
 * Home with nothing on it yet. Where YouTube Music can't be reached (the Free-only tier), it says
 * how to get it, instead of promising its catalog.
 */
function WelcomeCard({ freeOnly }: { freeOnly: boolean }) {
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const titleId = useId()
  const device = useMemo(currentDevice, [])
  // Where nothing can be installed, searching is the way forward.
  const install = freeOnly && canGetMoreHere(device)
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
        <h2
          id={titleId}
          tabIndex={-1}
          data-home-heading=""
          className="mt-2 text-2xl font-extrabold tracking-tight sm:text-3xl"
        >
          Play practically any song
        </h2>
        <p className="mt-2 text-text-muted">
          {freeOnly
            ? getYouTubeText(
                device,
                'FXM plays the YouTube Music catalog, and finds new music there for you',
              )
            : catalogMode === 'music'
              ? 'Clean album audio from the YouTube Music catalog. Switch to Music + Video for covers, live sets and remixes.'
              : 'Songs plus any YouTube video – covers, live sets, remixes – all played as music.'}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          {install && <GetConnectLink variant="primary" device={device} />}
          <Link
            to="/search"
            className={buttonClasses({ variant: install ? 'secondary' : 'primary' })}
          >
            <Search aria-hidden="true" />
            Search music
          </Link>
          {freeOnly && !install && <GetConnectLink variant="secondary" device={device} />}
          {!freeOnly && (
            <Link to="/settings" className={buttonClasses({ variant: 'secondary' })}>
              <SlidersHorizontal aria-hidden="true" />
              Change mode
            </Link>
          )}
        </div>
      </div>
    </section>
  )
}

/** In the Free-only tier, below the user's own shelves: how to get recommendations too. */
function RecommendationsNote() {
  const headingId = useId()
  const device = useMemo(currentDevice, [])
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
            {getYouTubeText(device, 'FXM finds new music for you on YouTube Music')}
          </p>
        </div>
      </div>
      <div className="pl-8 sm:pl-0">
        <GetConnectLink variant="secondary" device={device} />
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

/** Where focus goes next, once that part of Home shows. */
type FocusTarget = 'reminder' | 'onboarding' | 'picks' | 'editor'

/**
 * Everything on Home below the greeting: the notes, the onboarding and the shelves. A lazy chunk
 * of its own, so the library database and the recommendation engine load after the page shows.
 *
 * Home comes in two passes (`use-home-feed.ts`): the user's own shelves at once, with a
 * placeholder where the recommendations will go, then everything. Whatever replaces the button
 * that had focus takes it, so focus never drops to the page: the reminder after "Not now", the
 * onboarding after "Pick artists", and the first shelf once Home is built from the picks.
 */
export function HomeContent() {
  const services = useHomeServices()
  const reach = useHomeReach(services)
  const feed = useHomeFeed()
  const picks = useTasteStore((state) => state.picks)
  const dismissed = useTasteStore((state) => state.dismissedAt !== undefined)
  const savePicks = useTasteStore((state) => state.savePicks)
  const clearPicks = useTasteStore((state) => state.clearPicks)
  const dismiss = useTasteStore((state) => state.dismiss)
  const reopen = useTasteStore((state) => state.reopen)
  const [openMix, setOpenMix] = useState<DailyMix | null>(null)
  /** Home is being built from the picks just made: the onboarding waits for it. */
  const [building, setBuilding] = useState(false)
  /** The picks are being changed, at the end of Home. */
  const [editing, setEditing] = useState(false)
  const [focusNext, setFocusNext] = useState<FocusTarget | null>(null)
  /** Focus goes to the first heading of Home: it has been built from the picks. */
  const [focusHome, setFocusHome] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  const recommending = canRecommend(services, reach)
  const freeOnly = reach.capabilities.youtube === 'none'
  /** The tier is still being worked out: FXM Connect waking up, or the first Lite check. */
  const detecting = reach.detecting === true
  const data = feed.data
  const shelves = data?.shelves ?? []
  /** Home as built, not a first pass nor the Home shown before. */
  const built = feed.status === 'success' && !feed.isPlaceholderData
  const coldStart = recommending && data?.coldStart === true
  const showOnboarding = building || (coldStart && !dismissed)
  const showReminder = !showOnboarding && coldStart
  const loading = feed.status === 'pending'
  // While the sources are asked, a placeholder holds the place of the recommendations.
  const finding = recommending && data?.phase === 'local' && !data.coldStart
  // While the tier is unknown, Home doesn't say what this browser lacks, which would most likely
  // be wrong: a placeholder holds the place of the welcome until the tier is known.
  const waiting = detecting && !loading && shelves.length === 0 && !showOnboarding

  /** The picks and their editor follow Home's shelves, once there is a Home to show. */
  const picksShown = recommending && !showOnboarding && !showReminder && data !== undefined
  const targetShown =
    (focusNext === 'reminder' && showReminder) ||
    (focusNext === 'onboarding' && showOnboarding) ||
    (focusNext === 'picks' && picksShown && !editing) ||
    (focusNext === 'editor' && picksShown && editing)

  // Each target takes focus as it mounts; then the request is done. A target that isn't on the
  // page yet keeps the request until it is (the picks, saved while Home was still being built,
  // show once Home has been built from them), or until Home is built without it.
  useEffect(() => {
    if (focusNext !== null && (targetShown || built)) setFocusNext(null)
  }, [focusNext, targetShown, built])

  // Home built from the picks: the onboarding goes, and focus moves to the first shelf (or to
  // the welcome, when nothing came of them).
  useEffect(() => {
    if (!building || loading || feed.isPlaceholderData) return
    setBuilding(false)
    setFocusHome(true)
  }, [building, loading, feed.isPlaceholderData])
  useEffect(() => {
    if (!focusHome) return
    setFocusHome(false)
    root.current?.querySelector<HTMLElement>('[data-home-heading]')?.focus()
  }, [focusHome])

  const onBuild = (chosen: { artists: PickedArtist[]; genres: string[] }) => {
    setBuilding(true)
    savePicks(chosen, Date.now())
  }
  const onSavePicks = (chosen: { artists: PickedArtist[]; genres: string[] }) => {
    savePicks(chosen, Date.now())
    setEditing(false)
    setFocusNext('picks')
    showStatus('Saved your artists')
  }

  return (
    // A flex column, not space-y: the closed dialog takes no room.
    <div ref={root} className="flex flex-col gap-10 md:gap-12">
      {showOnboarding && (
        <TasteOnboarding
          busy={building}
          focusOnMount={focusNext === 'onboarding'}
          onSubmit={onBuild}
          onCancel={() => {
            dismiss(Date.now())
            setFocusNext('reminder')
          }}
        />
      )}
      {showReminder && (
        <TasteReminder
          focusOnMount={focusNext === 'reminder'}
          onReopen={() => {
            reopen()
            setFocusNext('onboarding')
          }}
        />
      )}

      {(loading || finding || waiting) && (
        <HomeSkeleton
          shelves={loading || waiting ? 3 : 2}
          label={loading || waiting ? 'Loading your Home…' : 'Finding music for you…'}
        />
      )}
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
      {built && shelves.length === 0 && !showOnboarding && !detecting && (
        <WelcomeCard freeOnly={freeOnly} />
      )}
      {freeOnly && !detecting && shelves.length > 0 && <RecommendationsNote />}

      {picksShown &&
        (editing ? (
          <TasteOnboarding
            mode="edit"
            initial={picks}
            focusOnMount={focusNext === 'editor'}
            onSubmit={onSavePicks}
            onCancel={() => {
              setEditing(false)
              setFocusNext('picks')
            }}
          />
        ) : (
          <TastePicksSection
            picks={picks}
            focus={focusNext === 'picks'}
            onChange={() => {
              setEditing(true)
              setFocusNext('editor')
            }}
            onClear={() => {
              clearPicks()
              setFocusNext('picks')
              showStatus('Cleared your artists')
            }}
          />
        ))}

      <MixDialog mix={openMix} playback={services.playback} onClose={() => setOpenMix(null)} />
    </div>
  )
}
