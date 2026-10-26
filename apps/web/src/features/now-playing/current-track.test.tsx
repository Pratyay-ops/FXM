import {
  createQueue,
  currentQueueItem,
  type QueueState,
  setQueue,
  setQueueCandidate,
  type Track,
} from '@fxm/core'
import type { PlayerState, PlayerStatus } from '@fxm/player'
import { testStream, testTrack, testTracks } from '@fxm/player/testing'
import { act, render, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  currentTrackOf,
  nowPlayingStatusFor,
  nowPlayingStatusOf,
  rowCopies,
  useNowPlayingStatus,
} from './current-track'
import { setupTestPlayback, spotifyTrack, testCandidate } from './testing'

/** The part of a player's state the current track comes from. */
function stateOf(queue: QueueState, status: PlayerStatus = 'playing'): PlayerState {
  return { queue, status } as PlayerState
}

/** A queue of `tracks` that plays the one at `startIndex`. */
function queueOf(tracks: readonly Track[], startIndex = 0, shuffle = false): QueueState {
  return setQueue(createQueue(), tracks, { startIndex, shuffle, random: () => 0 })
}

/** The marker of each row of a list of `tracks`, as the list would mark them. */
function marks(state: PlayerState, tracks: readonly Track[]) {
  const current = currentTrackOf(state)
  const copies = rowCopies(tracks.map((track) => track.id))
  return tracks.map((track, index) => nowPlayingStatusOf(current, track.id, copies[index]))
}

// "Neon Harbor" from Spotify, and the YouTube Music recording its match plays.
const PICKED = spotifyTrack('Neon Harbor')
const RECORDING = testTrack('nEoNhArBoR1', { title: 'Neon Harbor' })
const MATCH = testCandidate('nEoNhArBoR1', { title: 'Neon Harbor' })

/** The queue playing `PICKED` through its match, as the player records it. */
function playingThroughMatch(): QueueState {
  const queue = queueOf([PICKED])
  const item = currentQueueItem(queue)
  if (item === undefined) throw new Error('No current item')
  return setQueueCandidate(queue, item.uid, MATCH)
}

describe('currentTrackOf', () => {
  it('is undefined while the queue is empty', () => {
    expect(currentTrackOf(stateOf(createQueue()))).toBeUndefined()
  })

  it('names the track that was picked, not the recording a match plays', () => {
    const queue = playingThroughMatch()
    expect(currentQueueItem(queue)?.candidate?.ref).toBe('nEoNhArBoR1')
    expect(currentTrackOf(stateOf(queue))).toEqual({ id: PICKED.id, copy: 1, status: 'playing' })
  })

  it('says playing while the track plays or loads, and paused otherwise', () => {
    const statuses: PlayerStatus[] = ['loading', 'playing', 'paused', 'ended', 'error', 'idle']
    expect(statuses.map(nowPlayingStatusFor)).toEqual([
      'playing',
      'playing',
      'paused',
      'paused',
      'paused',
      'paused',
    ])
    expect(currentTrackOf(stateOf(queueOf(testTracks('a')), 'paused'))?.status).toBe('paused')
  })

  it('counts which copy of a repeated track plays, in the order the queue was given', () => {
    const [a, b] = testTracks('a', 'b') as [Track, Track]
    expect(currentTrackOf(stateOf(queueOf([a, b, a], 0)))?.copy).toBe(1)
    expect(currentTrackOf(stateOf(queueOf([a, b, a], 2)))?.copy).toBe(2)
    // Shuffled, the second copy plays first, and is still the second copy.
    const shuffled = queueOf([a, b, a], 2, true)
    expect(shuffled.index).toBe(0)
    expect(currentTrackOf(stateOf(shuffled))?.copy).toBe(2)
  })
})

describe('nowPlayingStatusOf', () => {
  it('marks the row that was tapped for a matched song, never a row of its recording', () => {
    const state = stateOf(playingThroughMatch())
    // A Spotify list with the song, and a YouTube Music list with the recording it plays.
    expect(marks(state, [spotifyTrack('Intro'), PICKED])).toEqual([undefined, 'playing'])
    expect(marks(state, [RECORDING, testTrack('Outro')])).toEqual([undefined, undefined])
  })

  it('marks the recording, not the Spotify song matched to it, when the recording plays', () => {
    const state = stateOf(queueOf([RECORDING]), 'paused')
    expect(marks(state, [PICKED])).toEqual([undefined])
    expect(marks(state, [RECORDING])).toEqual(['paused'])
  })

  it('marks the same recording in both lists that show it, and no other song of its name', () => {
    const song = testTrack('Copper Sun')
    const album = [testTrack('First Light'), song, testTrack('Low Tide')]
    const playlist = [testTrack('Static Bloom'), song]
    // Played from the album: the playlist shows the same track, and marks it too.
    const state = stateOf(queueOf(album, 1))
    expect(marks(state, album)).toEqual([undefined, 'playing', undefined])
    expect(marks(state, playlist)).toEqual([undefined, 'playing'])
    const namesake = testTrack('Copper Sun (cover)', { title: 'Copper Sun' })
    expect(marks(state, [namesake])).toEqual([undefined])
  })

  it('marks one copy of a track a list repeats: the one the queue plays', () => {
    const [a, b] = testTracks('a', 'b') as [Track, Track]
    const list = [a, b, a]
    expect(marks(stateOf(queueOf(list, 0)), list)).toEqual(['playing', undefined, undefined])
    expect(marks(stateOf(queueOf(list, 2)), list)).toEqual([undefined, undefined, 'playing'])
    // Another list with the track once marks it, whichever copy plays.
    expect(marks(stateOf(queueOf(list, 2)), [b, a])).toEqual([undefined, 'playing'])
    // A queue with more copies than the list: the list's last copy.
    const thrice = [a, a, a]
    expect(marks(stateOf(queueOf(thrice, 2)), list)).toEqual([undefined, undefined, 'playing'])
  })

  it('marks nothing while the queue is empty, nor a row without a track', () => {
    expect(nowPlayingStatusOf(undefined, PICKED.id)).toBeUndefined()
    expect(nowPlayingStatusOf(currentTrackOf(stateOf(queueOf([PICKED]))), undefined)).toBe(
      undefined,
    )
  })
})

describe('rowCopies', () => {
  it('numbers the copies of each track in list order', () => {
    expect(rowCopies(['a', 'b', 'a', 'a'])).toEqual([
      { copy: 1, copies: 3 },
      { copy: 1, copies: 1 },
      { copy: 2, copies: 3 },
      { copy: 3, copies: 3 },
    ])
  })
})

describe('useNowPlayingStatus', () => {
  it('follows the player: next, previous, autoplay’s additions, a new queue, a cleared one', async () => {
    const { player, engine } = setupTestPlayback()
    const [a, b, c] = testTracks('a', 'b', 'c') as [Track, Track, Track]
    const { result } = renderHook(() => [a, b, c].map((track) => useNowPlayingStatus(track.id)))
    expect(result.current).toEqual([undefined, undefined, undefined])

    await act(() => player.setQueue([a, b]))
    expect(result.current).toEqual(['playing', undefined, undefined])
    await act(() => player.next())
    expect(result.current).toEqual([undefined, 'playing', undefined])
    await act(() => player.previous())
    expect(result.current).toEqual(['playing', undefined, undefined])
    act(() => player.pause())
    expect(result.current).toEqual(['paused', undefined, undefined])

    // Autoplay adds songs at the end of the queue; the marker moves on when they play.
    act(() => player.addToQueue([c]))
    await act(() => player.play(2))
    expect(result.current).toEqual([undefined, undefined, 'playing'])
    act(() => engine.end())
    expect(result.current).toEqual([undefined, undefined, 'paused'])

    await act(() => player.setQueue([b]))
    expect(result.current).toEqual([undefined, 'playing', undefined])
    await act(() => player.setQueue([]))
    expect(result.current).toEqual([undefined, undefined, undefined])
  })

  it('marks the row of a matched song while its match plays', async () => {
    const { player, resolver } = setupTestPlayback()
    resolver.handler = (item) => ({ stream: testStream(item.track.title), candidate: MATCH })
    const { result } = renderHook(() => [
      useNowPlayingStatus(PICKED.id),
      useNowPlayingStatus(RECORDING.id),
    ])

    await act(() => player.setQueue([PICKED]))

    expect(currentQueueItem(player.getState().queue)?.candidate).toEqual(MATCH)
    expect(player.getState().status).toBe('playing')
    expect(result.current).toEqual(['playing', undefined])
  })

  it('re-renders no row on a playback tick, and only the rows that change on a new track', async () => {
    const { player, engine } = setupTestPlayback()
    const tracks = testTracks(...Array.from({ length: 50 }, (_, index) => `t${index}`))
    const renders: string[] = []
    function Row({ track }: { track: Track }) {
      const status = useNowPlayingStatus(track.id)
      renders.push(track.title)
      return <li aria-current={status === undefined ? undefined : 'true'}>{track.title}</li>
    }
    render(
      <ul>
        {tracks.map((track) => (
          <Row key={track.id} track={track} />
        ))}
      </ul>,
    )
    await act(() => player.setQueue(tracks))

    renders.length = 0
    act(() => {
      for (let positionMs = 250; positionMs <= 10_000; positionMs += 250) {
        engine.progress(positionMs)
      }
    })
    expect(player.getState().positionMs).toBe(10_000)
    expect(renders).toEqual([])

    await act(() => player.next())
    expect([...new Set(renders)].sort()).toEqual(['t0', 't1'])

    renders.length = 0
    act(() => player.pause())
    expect(renders).toEqual(['t1'])
  })
})
