import {
  type CatalogMode,
  currentQueueItem,
  isFxmError,
  type Lyrics,
  type QueueItem,
  type Track,
} from '@fxm/core'
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query'
import { usePlayerState } from '../now-playing/playback'
import { useSettingsStore } from '../settings/settings-store'
import { awaitsMatch, getLyricsProvider, lyricsContext, lyricsTrackFor } from './lyrics-source'

/**
 * The query for a track's lyrics. The key holds what the lookup sends, with the duration in the
 * whole seconds LRCLIB gets, so the same lookup is never made twice and another version of the
 * track (a clearly different length) is looked up again. Lyrics don't change while the app
 * runs: they are fetched once per track and kept for half an hour after the last use. A failed
 * lookup is retried once, unless LRCLIB asked FXM to slow down. The catalog mode only fills in
 * the provider context: lyrics don't depend on it.
 */
export function lyricsQuery(track: Track, mode: CatalogMode) {
  const artists = track.artists.map((artist) => artist.name)
  const seconds = track.durationMs === undefined ? null : Math.round(track.durationMs / 1000)
  return queryOptions({
    queryKey: ['lyrics', track.id, track.title, artists, seconds],
    queryFn: ({ signal }): Promise<Lyrics | null> =>
      getLyricsProvider().getLyrics(track, lyricsContext(mode, signal)),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: (failures, error) => failures < 1 && !isFxmError(error, 'RateLimited'),
  })
}

/**
 * The lyrics of what `item` plays (see `lyricsTrackFor`); `null` data means it has none.
 *
 * While the player finds the audio of a track that plays through a match, the lookup waits for
 * it (the query stays pending), because the match decides what to look up. If the lookup still
 * changes for the same item, say when a paused track starts and turns out to play a song of
 * another length, the lyrics found so far stay until the new ones arrive (`isPlaceholderData`).
 */
export function useLyrics(item: QueueItem) {
  const mode = useSettingsStore((state) => state.catalogMode)
  const resolving = usePlayerState(
    (state) => state.status === 'loading' && currentQueueItem(state.queue)?.uid === item.uid,
  )
  return useQuery({
    ...lyricsQuery(lyricsTrackFor(item), mode),
    enabled: !(resolving && awaitsMatch(item, mode)),
    placeholderData: keepPreviousData,
  })
}
