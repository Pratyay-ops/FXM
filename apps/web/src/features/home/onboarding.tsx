/**
 * The cold start: when FXM knows too little about the user's taste to recommend anything, Home
 * asks for three or more artists and any genres. The picks stay on this device (see
 * `taste-store.ts`), and the engine counts them like likes, so they seed the first mixes and
 * fade as real listening takes over.
 *
 * Artists to pick from: the artists the user follows, and the artists of the services' own
 * home feeds (regional charts and popular artists, e.g. Spotify's home for the user's market),
 * when they can be reached. Any other artist can be typed in.
 *
 * @module
 */

import { isEntityId, type PickedArtist, type ShelfItem } from '@fxm/core'
import { useQuery } from '@tanstack/react-query'
import { Check, Plus, Sparkles, X } from 'lucide-react'
import { type FormEvent, useId, useMemo, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { useFollows } from '../../db/hooks'
import { cn } from '../../lib/cn'
import { useSettingsStore } from '../settings/settings-store'
import { canRecommend, type HomeServices, useHomeReach, useHomeServices } from './services'
import { useTasteStore } from './taste-store'
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
    const seen = new Set<string>()
    return [...followed, ...(charts.data ?? [])]
      .filter((artist) => {
        const key = artist.name.toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, MAX_SUGGESTIONS)
  }, [follows, charts.data])
  return { artists, loading: enabled && charts.isPending }
}

/** A chip that toggles, for artists and genres. */
function Chip({
  label,
  pressed,
  onToggle,
}: {
  label: string
  pressed: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={cn(
        'inline-flex h-touch items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors lg:h-9 lg:pointer-coarse:h-touch [&_svg]:size-4',
        pressed
          ? 'border-accent bg-accent text-on-accent forced-colors:border-[Highlight] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]'
          : 'border-border-strong bg-transparent text-text hover:bg-text/8',
      )}
    >
      {pressed && <Check aria-hidden="true" />}
      {label}
    </button>
  )
}

/** The cold-start onboarding (see the module documentation). */
export function TasteOnboarding() {
  const services = useHomeServices()
  const savePicks = useTasteStore((state) => state.savePicks)
  const dismiss = useTasteStore((state) => state.dismiss)
  const { artists: suggested, loading } = useSuggestedArtists(services)
  const [picked, setPicked] = useState<PickedArtist[]>([])
  const [typed, setTyped] = useState<PickedArtist[]>([])
  const [genres, setGenres] = useState<string[]>([])
  const [name, setName] = useState('')
  const headingId = useId()
  const inputId = useId()

  const isPicked = (artist: PickedArtist) =>
    picked.some((one) => one.name.toLowerCase() === artist.name.toLowerCase())
  const toggleArtist = (artist: PickedArtist) =>
    setPicked((current) =>
      isPicked(artist)
        ? current.filter((one) => one.name.toLowerCase() !== artist.name.toLowerCase())
        : [...current, artist],
    )
  const toggleGenre = (genre: string) =>
    setGenres((current) =>
      current.includes(genre) ? current.filter((one) => one !== genre) : [...current, genre],
    )

  const addTyped = (event: FormEvent) => {
    event.preventDefault()
    const clean = name.replace(/\s+/gu, ' ').trim()
    if (clean === '') return
    const artist = { name: clean }
    const known = [...suggested, ...typed].some(
      (one) => one.name.toLowerCase() === clean.toLowerCase(),
    )
    if (!known) setTyped((current) => [...current, artist])
    if (!isPicked(artist)) setPicked((current) => [...current, artist])
    setName('')
  }

  const missing = Math.max(0, MIN_PICKED_ARTISTS - picked.length)
  const choices = [...suggested, ...typed]

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-2xl border border-border bg-surface p-5 shadow-lg sm:p-7"
    >
      <div className="flex items-start gap-3">
        <Sparkles aria-hidden="true" className="mt-1 size-5 shrink-0 text-accent" />
        <div>
          <h2 id={headingId} className="text-2xl font-extrabold tracking-tight">
            What do you like to listen to?
          </h2>
          <p className="mt-1 max-w-2xl text-text-muted">
            Pick at least {MIN_PICKED_ARTISTS} artists, and any genres you like. FXM builds your
            Home from them, on this device only.
          </p>
        </div>
      </div>

      <fieldset className="mt-6">
        <legend className="text-sm font-semibold">Artists</legend>
        {choices.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {choices.map((artist) => (
              <Chip
                key={artist.name.toLowerCase()}
                label={artist.name}
                pressed={isPicked(artist)}
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
          className="h-touch min-w-0 flex-1 rounded-full border border-border-strong bg-elevated px-4 text-base outline-none focus-visible:border-accent"
        />
        <button
          type="submit"
          disabled={name.trim() === ''}
          className={buttonClasses({ variant: 'secondary' })}
        >
          <Plus aria-hidden="true" />
          Add
        </button>
      </form>

      <fieldset className="mt-6">
        <legend className="text-sm font-semibold">Genres</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {ONBOARDING_GENRES.map((genre) => (
            <Chip
              key={genre}
              label={genre}
              pressed={genres.includes(genre)}
              onToggle={() => toggleGenre(genre)}
            />
          ))}
        </div>
      </fieldset>

      <div className="mt-7 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={missing > 0}
          onClick={() => savePicks({ artists: picked, genres }, Date.now())}
          className={buttonClasses()}
        >
          <Sparkles aria-hidden="true" />
          Build my Home
        </button>
        <button
          type="button"
          onClick={() => dismiss(Date.now())}
          className={buttonClasses({ variant: 'ghost' })}
        >
          <X aria-hidden="true" />
          Not now
        </button>
        <p aria-live="polite" className="text-sm text-text-muted">
          {missing > 0
            ? `Pick ${missing} more ${missing === 1 ? 'artist' : 'artists'}`
            : `${picked.length} artists picked`}
        </p>
      </div>
    </section>
  )
}

/** After "Not now": a small way back to the onboarding. */
export function TasteReminder() {
  const reopen = useTasteStore((state) => state.reopen)
  const headingId = useId()
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
        <button type="button" onClick={reopen} className={buttonClasses({ variant: 'secondary' })}>
          Pick artists
        </button>
      </div>
    </section>
  )
}
