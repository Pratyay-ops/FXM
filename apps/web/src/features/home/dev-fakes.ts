/**
 * Development only: `?fake-home=lite` or `?fake-home=full` in the URL plugs fake services into
 * Home, so its shelves and onboarding can be seen and tried without the platform and providers
 * of other stages (the tab keeps the choice until `?fake-home=off`). The fakes suggest songs
 * from a small invented catalog, with no network and no artwork. Production builds leave this
 * module out (see `services.tsx`).
 *
 * The Home's own shelves (On repeat, Rediscover) come from the real library: restore a backup
 * with plays (the Library page's Backup, e.g. `e2e/fixtures/library-backup.json`) to see them.
 *
 * @module
 */

import {
  type ArtistRef,
  formatId,
  isTrackSeed,
  type RadioSeed,
  type RecCandidate,
  recSeedOf,
  type Track,
} from '@fxm/core'
import { type HomeServices, type HomeServicesStore, staticSources } from './services'

const SESSION_KEY = 'fxm.home.fake'

/** The invented artists, each with eight songs. */
const ARTISTS = [
  'Aurora Lane',
  'Basalt',
  'Cinder',
  'Dune Theory',
  'Ember Fold',
  'Fable Kin',
  'Glass Choir',
  'Halcyon',
  'Iris Vale',
  'Juniper Coast',
  'Kestrel',
  'Lark Avenue',
  'Mirror Lake',
  'Northern Fern',
  'Orchid Static',
  'Quiet Harbor',
] as const

const WORDS = ['Copper', 'Static', 'Harbor', 'Glass', 'Paper', 'Velvet', 'Silver', 'Hollow']
const NOUNS = ['Sun', 'Bloom', 'Lights', 'River', 'Moons', 'Signal', 'Tide', 'Echo']

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, '-')
}

function songsOf(artist: string, index: number): Track[] {
  return WORDS.map((word, n) => ({
    id: formatId('ytm', 'track', `fake-${slug(artist)}-${n}`),
    source: 'ytm',
    title: `${word} ${NOUNS[(n + index) % NOUNS.length]}`,
    artists: [{ id: formatId('ytm', 'artist', `fake-${slug(artist)}`), name: artist }],
    artwork: [],
    durationMs: 150_000 + ((index * 7 + n * 13) % 120) * 1000,
    kind: 'song',
  }))
}

const CATALOG = new Map<string, Track[]>(
  ARTISTS.map((artist, index) => [artist, songsOf(artist, index)]),
)

/** Twenty songs "like" a seed: the seed artist's neighbours in the list, taking turns. */
function radioFor(seed: RadioSeed): Track[] {
  const artist = isTrackSeed(seed) ? (seed.artists[0]?.name ?? '') : seed.name
  const at = Math.max(0, (ARTISTS as readonly string[]).indexOf(artist))
  const near = [1, 2, 3, 4, 5].map((step) => ARTISTS[(at + step) % ARTISTS.length] as string)
  const tracks: Track[] = []
  for (let round = 0; round < 4; round++) {
    for (const name of near) {
      const song = CATALOG.get(name)?.[round]
      if (song !== undefined) tracks.push(song)
    }
  }
  return tracks
}

/** Fake services in a tier: recommendation sources, a catalog and a no-op playback. */
export function fakeHomeServices(tier: 'lite' | 'full'): HomeServices {
  const capabilities =
    tier === 'full'
      ? ({ youtube: 'full', spotify: 'account', mediaBytes: true, fileSystem: false } as const)
      : ({
          youtube: 'simple',
          spotify: 'unreachable',
          mediaBytes: false,
          fileSystem: false,
        } as const)
  return {
    sources: staticSources(capabilities),
    recommendations: {
      async collect(seed) {
        const tracks = radioFor(seed)
        const candidates: RecCandidate[] = tracks.map((track, rank) => ({
          type: 'track',
          source: 'ytm',
          part: 'radio',
          seed: recSeedOf(seed),
          rank,
          score: (tracks.length - rank) / tracks.length,
          track,
        }))
        return { candidates }
      },
      async home() {
        return {
          shelves: [
            {
              source: 'ytm',
              shelf: {
                id: 'fake-popular',
                title: 'Popular artists',
                items: ARTISTS.slice(0, 12).map((name) => ({
                  type: 'artist' as const,
                  artist: {
                    id: formatId('ytm', 'artist', `fake-${slug(name)}`),
                    source: 'ytm' as const,
                    name,
                    artwork: [],
                  },
                })),
              },
            },
            ...(tier === 'full'
              ? [
                  {
                    source: 'spotify',
                    shelf: {
                      id: 'fake-made-for-you',
                      title: 'Made For You',
                      items: (CATALOG.get('Kestrel') ?? []).slice(0, 6).map((track) => ({
                        type: 'track' as const,
                        track,
                      })),
                    },
                  },
                ]
              : []),
          ],
        }
      },
    },
    catalog: {
      async findArtist(name): Promise<ArtistRef | null> {
        const known = ARTISTS.find((artist) => artist.toLowerCase() === name.toLowerCase())
        return known === undefined
          ? null
          : { id: formatId('ytm', 'artist', `fake-${slug(known)}`), name: known }
      },
      async artistTracks(artist) {
        return CATALOG.get(artist.name) ?? []
      },
    },
    spotifyAccount: { status: async () => ({ connected: tier === 'full' }) },
    playback: {
      play(tracks, options) {
        console.info(
          'Fake Home playback:',
          tracks[options?.startIndex ?? 0]?.title,
          options?.context,
        )
      },
    },
  }
}

/**
 * The fakes' tier this tab asked for: `?fake-home=lite` or `full` sets it (`off` clears it), and
 * otherwise the one set earlier in this tab, if any. The app's composition root asks too, and
 * leaves Home to the fakes then.
 */
export function readHomeFakeTier(): 'lite' | 'full' | undefined {
  try {
    const asked = new URLSearchParams(globalThis.location?.search ?? '').get('fake-home')
    if (asked !== null) sessionStorage.setItem(SESSION_KEY, asked)
    const choice = sessionStorage.getItem(SESSION_KEY)
    return choice === 'lite' || choice === 'full' ? choice : undefined
  } catch {
    return undefined
  }
}

/** Plugs the fakes in when the URL (or this tab, earlier) asks for them. */
export function installHomeDevFakes(store: HomeServicesStore): void {
  const tier = readHomeFakeTier()
  if (tier !== undefined) store.set(fakeHomeServices(tier))
}
