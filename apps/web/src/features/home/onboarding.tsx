/**
 * The cold start: when FXM knows too little about the user's taste to recommend anything, Home
 * asks for three or more artists and any genres. The picks stay on this device (see
 * `taste-store.ts`), and the engine counts them like likes, so they seed the first mixes and
 * fade as real listening takes over. The same form changes the picks later, from the end of
 * Home (`TastePicksSection`).
 *
 * Artists to pick from: the artists the user follows, and the artists of the services' own
 * home feeds (regional charts and popular artists, e.g. Spotify's home for the user's market),
 * when they can be reached. Any other artist can be typed in.
 *
 * @module
 */

import { isEntityId, type PickedArtist, type ShelfItem, type TastePicks } from '@fxm/core'
import { useQuery } from '@tanstack/react-query'
import { Check, LoaderCircle, Plus, Sparkles, X } from 'lucide-react'
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { useFollows } from '../../db/hooks'
import { cn } from '../../lib/cn'
import { useSettingsStore } from '../settings/settings-store'
import { canRecommend, type HomeServices, useHomeReach, useHomeServices } from './services'
import { versionOf } from './use-home-feed'

/** Fewer artists than this, and Home can't be built from the picks. */
export const MIN_PICKED_ARTISTS = 3

/** Genres to pick from. They count wherever sources tag their songs (Jamendo, local files…). */
export const ONBOARDING_GENRES = [
  'Pop',
  'Hip-hop',
  'Rock',
  'Indie',
  'Electronic',
  'Dance',
  'R&B',
  'Soul',
  'Jazz',
  'Classical',
  'Metal',
  'Punk',
  'Folk',
  'Country',
  'Blues',
  'Reggae',
  'Latin',
  'Afrobeats',
  'K-pop',
  'J-pop',
  'Bollywood',
  'Lo-fi',
  'Ambient',
  'Soundtrack',
] as const

/** Most suggested artists shown. */
const MAX_SUGGESTIONS = 24

/** Names longer than this get a tooltip: their chip may cut them short. */
const LONG_NAME = 24

/** Whether two picks name the same artist (ignoring case). */
function sameArtist(a: PickedArtist, b: PickedArtist): boolean {
  return a.name.toLowerCase() === b.name.toLowerCase()
}

/**
 * Artists once each by name (ignoring case), in their first place: a listing with an ID wins
 * over one without, so a pick keeps the ID a suggestion carries.
 */
export function mergeArtists(artists: readonly PickedArtist[]): PickedArtist[] {
  const merged: PickedArtist[] = []
  const at = new Map<string, number>()
  for (const artist of artists) {
    const key = artist.name.toLowerCase()
    const index = at.get(key)
    if (index === undefined) {
      at.set(key, merged.length)
      merged.push(artist)
    } else if (merged[index]?.id === undefined && artist.id !== undefined) {
      merged[index] = artist
    }
  }
  return merged
}

/** The artists of a feed's sections: artist items, and the main artist of each song. */
export function artistsOfShelves(items: readonly ShelfItem[]): PickedArtist[] {
  const artists: PickedArtist[] = []
  const seen = new Set<string>()
  const add = (name: string | undefined, id: unknown) => {
    const clean = name?.trim()
    if (!clean || seen.has(clean.toLowerCase())) return
    seen.add(clean.toLowerCase())
    artists.push(isEntityId(id, 'artist') ? { name: clean, id } : { name: clean })
  }
  for (const item of items) {
    if (item.type === 'artist') add(item.artist.name, item.artist.id)
    else if (item.type === 'track') add(item.track.artists[0]?.name, item.track.artists[0]?.id)
    else if (item.type === 'album') add(item.album.artists[0]?.name, item.album.artists[0]?.id)
  }
  return artists
}

/** Artists to suggest: the ones the user follows, then the services' popular ones. */
function useSuggestedArtists(services: HomeServices) {
  const reach = useHomeReach(services)
  const mode = useSettingsStore((state) => state.catalogMode)
  const follows = useFollows('artist')
  const enabled = canRecommend(services, reach)
  const charts = useQuery({
    queryKey: [
      'home',
      'onboarding',
      'artists',
      mode,
      reach.capabilities.youtube,
      reach.capabilities.spotify,
      reach.spotifyEnabled,
      versionOf(services),
    ],
    enabled,
    staleTime: 30 * 60_000,
    queryFn: async ({ signal }) => {
      const recommendations = services.recommendations
      if (recommendations === undefined) return []
      const { shelves } = await recommendations.home(services.sources.context({ mode, signal }))
      return artistsOfShelves(shelves.flatMap(({ shelf }) => shelf.items))
    },
  })
  const artists = useMemo(() => {
    const followed: PickedArtist[] =
      follows.status === 'ready'
        ? follows.data.map((record) =>
            isEntityId(record.id, 'artist')
              ? { name: record.name, id: record.id }
              : { name: record.name },
          )
        : []
    return mergeArtists([...followed, ...(charts.data ?? [])]).slice(0, MAX_SUGGESTIONS)
  }, [follows, charts.data])
  return { artists, loading: enabled && charts.isPending }
}

/** A chip that toggles, for artists and genres. A long name is cut short, with a tooltip. */
function Chip({
  label,
  pressed,
  disabled,
  onToggle,
}: {
  label: string
  pressed: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onToggle}
      title={label.length > LONG_NAME ? label : undefined}
      className={cn(
        // Kept clear of the sticky action bar when focus scrolls to it.
        'inline-flex h-touch max-w-full min-w-0 scroll-mb-28 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors lg:h-9 lg:pointer-coarse:h-touch [&_svg]:size-4 [&_svg]:shrink-0',
        // Forced colors (Windows High Contrast): the pressed chip in system colors, adjust-none
        // or the browser's text backplate hides the HighlightText label.
        pressed
          ? 'border-accent bg-accent text-on-accent forced-colors:border-[Highlight] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:forced-color-adjust-none forced-colors:focus-visible:outline-[CanvasText]'
          : 'border-border-strong bg-transparent text-text hover:bg-text/8',
      )}
    >
      {pressed && <Check aria-hidden="true" />}
      <span className="truncate">{label}</span>
    </button>
  )
}

/** Focuses `ref`'s element once, after it mounts, when asked to. */
function useFocusOnMount(ref: { current: HTMLElement | null }, focus: boolean | undefined) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when it mounts
  useEffect(() => {
    if (focus) ref.current?.focus()
  }, [])
}

/** What {@link TasteOnboarding} is for: the cold start, or changing the picks later. */
export type OnboardingMode = 'start' | 'edit'

const COPY: Readonly<
  Record<OnboardingMode, { title: string; text: string; submit: string; cancel: string }>
> = {
  start: {
    title: 'What do you like to listen to?',
    text: `Pick at least ${MIN_PICKED_ARTISTS} artists, and any genres you like. FXM builds your Home from them, on this device only.`,
    submit: 'Build my Home',
    cancel: 'Not now',
  },
  edit: {
    title: 'Your artists and genres',
    text: `Home grows from these as well as from what you play. Keep at least ${MIN_PICKED_ARTISTS} artists.`,
    submit: 'Save',
    cancel: 'Cancel',
  },
}

/** The onboarding (see the module documentation). */
export function TasteOnboarding({
  mode = 'start',
  initial,
  busy = false,
  focusOnMount,
  onSubmit,
  onCancel,
}: {
  /** The cold start, or changing the picks later. */
  mode?: OnboardingMode
  /** The picks to start from. */
  initial?: Pick<TastePicks, 'artists' | 'genres'> | undefined
  /** Home is being built from the picks: the form waits. */
  busy?: boolean
  /** Moves focus to the heading when it appears. */
  focusOnMount?: boolean
  onSubmit: (picks: { artists: PickedArtist[]; genres: string[] }) => void
  onCancel: () => void
}) {
  const services = useHomeServices()
  const { artists: suggested, loading } = useSuggestedArtists(services)
  const [picked, setPicked] = useState<PickedArtist[]>(() => [...(initial?.artists ?? [])])
  const [typed, setTyped] = useState<PickedArtist[]>([])
  const [genres, setGenres] = useState<string[]>(() => [...(initial?.genres ?? [])])
  const [name, setName] = useState('')
  const headingId = useId()
  const inputId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  useFocusOnMount(heading, focusOnMount)
  const copy = COPY[mode]

  // Each artist once: the picks to start from, the suggestions, then the names typed (next to
  // the field), with the ID a suggestion carries even when the name was typed first.
  const choices = useMemo(
    () => mergeArtists([...(initial?.artists ?? []), ...suggested, ...typed]),
    [initial, suggested, typed],
  )
  const best = (artist: PickedArtist) => choices.find((one) => sameArtist(one, artist)) ?? artist
  const isPicked = (artist: PickedArtist) => picked.some((one) => sameArtist(one, artist))
  const toggleArtist = (artist: PickedArtist) =>
    setPicked((current) =>
      current.some((one) => sameArtist(one, artist))
        ? current.filter((one) => !sameArtist(one, artist))
        : [...current, artist],
    )
  const toggleGenre = (genre: string) =>
    setGenres((current) =>
      current.includes(genre) ? current.filter((one) => one !== genre) : [...current, genre],
    )

  const addTyped = (event: FormEvent) => {
    event.preventDefault()
    const clean = name.replace(/\s+/gu, ' ').trim()
    if (clean === '' || busy) return
    const artist = best({ name: clean })
    if (!choices.some((one) => sameArtist(one, artist))) {
      setTyped((current) => [...current, artist])
    }
    if (!isPicked(artist)) setPicked((current) => [...current, artist])
    setName('')
  }

  // Genres picked once that the list no longer has stay, to be kept or dropped.
  const genreChoices = useMemo(
    () => [
      ...ONBOARDING_GENRES,
      ...(initial?.genres ?? []).filter(
        (genre) => !(ONBOARDING_GENRES as readonly string[]).includes(genre),
      ),
    ],
    [initial],
  )

  const missing = Math.max(0, MIN_PICKED_ARTISTS - picked.length)
  const submit = () => {
    if (busy || missing > 0) return
    onSubmit({ artists: picked.map(best), genres })
  }

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-2xl border border-border bg-surface p-5 shadow-lg sm:p-7"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <div className="flex flex-1 items-start gap-3">
          <Sparkles aria-hidden="true" className="mt-1 size-5 shrink-0 text-accent" />
          <div>
            <h2
              ref={heading}
              id={headingId}
              tabIndex={-1}
              className="text-2xl font-extrabold tracking-tight"
            >
              {copy.title}
            </h2>
            <p className="mt-1 max-w-2xl text-text-muted">{copy.text}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className={buttonClasses({ variant: 'ghost', className: 'self-start max-sm:ml-3' })}
        >
          <X aria-hidden="true" />
          {copy.cancel}
        </button>
      </div>

      {/* min-w-0: a fieldset is as wide as its widest chip otherwise, a long name included. */}
      <fieldset className="mt-6 min-w-0">
        <legend className="text-sm font-semibold">Artists</legend>
        {choices.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {choices.map((artist) => (
              <Chip
                key={artist.name.toLowerCase()}
                label={artist.name}
                pressed={isPicked(artist)}
                disabled={busy}
                onToggle={() => toggleArtist(artist)}
              />
            ))}
          </div>
        )}
        {loading && (
          <p role="status" className="mt-3 text-sm text-text-muted">
            Finding popular artists…
          </p>
        )}
      </fieldset>
      <form onSubmit={addTyped} className="mt-3 flex max-w-md gap-2">
        <label htmlFor={inputId} className="sr-only">
          Add an artist
        </label>
        <input
          id={inputId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Add an artist"
          maxLength={100}
          autoComplete="off"
          disabled={busy}
          className="h-touch min-w-0 flex-1 scroll-mb-28 rounded-full border border-border-strong bg-elevated px-4 text-base placeholder:text-text-muted"
        />
        <button
          type="submit"
          disabled={busy || name.trim() === ''}
          className={buttonClasses({ variant: 'secondary', className: 'scroll-mb-28' })}
        >
          <Plus aria-hidden="true" />
          Add
        </button>
      </form>

      <fieldset className="mt-6 min-w-0">
        <legend className="text-sm font-semibold">Genres</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {genreChoices.map((genre) => (
            <Chip
              key={genre}
              label={genre}
              pressed={genres.includes(genre)}
              disabled={busy}
              onToggle={() => toggleGenre(genre)}
            />
          ))}
        </div>
      </fieldset>

      {/* The action and the count stay in view while the user picks, above the bottom bars. */}
      <div className="sticky bottom-[calc(var(--shell-bottom)+0.5rem)] z-10 mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-elevated p-3 shadow-lg">
        <button
          type="button"
          aria-disabled={busy || missing > 0}
          onClick={submit}
          className={buttonClasses({
            className: cn(
              (busy || missing > 0) && 'opacity-50 hover:bg-accent active:scale-100',
              busy && 'cursor-progress',
            ),
          })}
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Sparkles aria-hidden="true" />
          )}
          {busy ? 'Building your Home…' : copy.submit}
        </button>
        <p aria-live="polite" className="text-sm text-text-muted">
          {busy ? (
            <span className="sr-only">Building your Home…</span>
          ) : missing > 0 ? (
            `Pick ${missing} more ${missing === 1 ? 'artist' : 'artists'}`
          ) : (
            `${picked.length} artists picked`
          )}
        </p>
      </div>
    </section>
  )
}

/** After "Not now": a small way back to the onboarding. */
export function TasteReminder({
  focusOnMount,
  onReopen,
}: {
  /** Moves focus to "Pick artists" when it appears. */
  focusOnMount?: boolean
  onReopen: () => void
}) {
  const headingId = useId()
  const button = useRef<HTMLButtonElement>(null)
  useFocusOnMount(button, focusOnMount)
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="flex flex-1 items-start gap-3">
        <Sparkles aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-text-muted" />
        <div className="space-y-0.5">
          <h2 id={headingId} className="text-sm font-semibold">
            Get recommendations sooner
          </h2>
          <p className="text-sm text-text-muted">
            Pick a few artists you like, or just play music: Home learns from what you play.
          </p>
        </div>
      </div>
      <div className="pl-8 sm:pl-0">
        <button
          ref={button}
          type="button"
          onClick={onReopen}
          className={buttonClasses({ variant: 'secondary' })}
        >
          Pick artists
        </button>
      </div>
    </section>
  )
}

/** "Aurora Lane, Basalt and 3 more". */
export function pickedNames(names: readonly string[], shown = 3): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= shown) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`
}

/**
 * At the end of Home, once it has more to go on than the picks: what the user picked, to change
 * or clear, or a way to pick some.
 */
export function TastePicksSection({
  picks,
  focus,
  onChange,
  onClear,
}: {
  picks: TastePicks | undefined
  /** Moves focus to the section's main button when it appears or changes. */
  focus?: boolean
  onChange: () => void
  onClear: () => void
}) {
  const headingId = useId()
  const main = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focus) main.current?.focus()
  }, [focus])
  const artists = picks?.artists.map((artist) => artist.name) ?? []
  const genres = picks?.genres ?? []
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Sparkles aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-text-muted" />
        <div className="min-w-0 space-y-0.5">
          <h2 id={headingId} className="text-sm font-semibold">
            Your artists
          </h2>
          <p className="text-sm break-words text-text-muted">
            {artists.length > 0
              ? `Home also grows from your picks: ${pickedNames(artists)}${
                  genres.length > 0 ? `, plus ${pickedNames(genres)}` : ''
                }.`
              : 'Pick a few artists and genres you like, and Home grows from them as well as from what you play.'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-8 sm:pl-0">
        <button
          ref={main}
          type="button"
          onClick={onChange}
          className={buttonClasses({ variant: 'secondary' })}
        >
          {artists.length > 0 ? 'Change' : 'Pick artists'}
        </button>
        {artists.length > 0 && (
          <button type="button" onClick={onClear} className={buttonClasses({ variant: 'ghost' })}>
            Clear picks
          </button>
        )}
      </div>
    </section>
  )
}
