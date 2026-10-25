import { type CatalogMode, isFxmError, type Lyrics, type QueueItem, type Track } from '@fxm/core'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { useSettingsStore } from '../settings/settings-store'
import { getLyricsProvider, lyricsContext, lyricsTrackFor } from './lyrics-source'

/**
 * The query for a track's lyrics. The key holds what the lookup sends, so a new version of the
 * track (another duration) looks its lyrics up again. Lyrics don't change while the app runs:
 * they are fetched once per track and kept for half an hour after the last use. A failed
 * lookup is retried once, unless LRCLIB asked FXM to slow down. The catalog mode only fills in
 * the provider context: lyrics don't depend on it.
 */
export function lyricsQuery(track: Track, mode: CatalogMode) {
  const artists = track.artists.map((artist) => artist.name)
  return queryOptions({
    queryKey: ['lyrics', track.id, track.title, artists, track.durationMs ?? null],
    queryFn: ({ signal }): Promise<Lyrics | null> =>
      getLyricsProvider().getLyrics(track, lyricsContext(mode, signal)),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: (failures, error) => failures < 1 && !isFxmError(error, 'RateLimited'),
  })
}

/** The lyrics of what `item` plays (see `lyricsTrackFor`); `null` data means it has none. */
export function useLyrics(item: QueueItem) {
  const mode = useSettingsStore((state) => state.catalogMode)
  return useQuery(lyricsQuery(lyricsTrackFor(item), mode))
}
