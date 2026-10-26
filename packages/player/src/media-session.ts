/**
 * Media Session: shows the current track in the system's media controls (lock screen,
 * notification, media keys, headset buttons) and sends their actions to the player.
 *
 * It does nothing where the browser has no Media Session API, and it skips any action or
 * position update the browser rejects.
 *
 * @module
 */

import { type Artwork, currentQueueItem, type Track } from '@fxm/core'
import type { Player, PlayerState, PlayerStatus } from './player'

/** The actions FXM handles, in the order they are registered. */
export const MEDIA_SESSION_ACTIONS = [
  'play',
  'pause',
  'previoustrack',
  'nexttrack',
  'seekto',
  'seekbackward',
  'seekforward',
  'stop',
] as const satisfies readonly MediaSessionAction[]

/** One of the {@link MEDIA_SESSION_ACTIONS}. */
export type FxmMediaSessionAction = (typeof MEDIA_SESSION_ACTIONS)[number]

/** The parts of a {@link Player} that the Media Session uses. */
export type MediaSessionPlayer = Pick<
  Player,
  | 'getState'
  | 'subscribe'
  | 'on'
  | 'play'
  | 'pause'
  | 'next'
  | 'previous'
  | 'seek'
  | 'seekBy'
  | 'stop'
>

/** Options for {@link connectMediaSession}. */
export interface MediaSessionOptions {
  /** The session to drive. Default: `navigator.mediaSession`, where the browser has one. */
  session?: MediaSession
  /** Builds the metadata object. Default: the browser's `MediaMetadata` constructor. */
  createMetadata?: (init: MediaMetadataInit) => MediaMetadata
  /** How far "seek backward" and "seek forward" jump when the system says nothing. Default: 10 s. */
  seekOffsetMs?: number
  /** The shortest time between two position updates during playback. Default: 1 s. */
  positionIntervalMs?: number
  /** The clock, in milliseconds, for spacing position updates. Default: `Date.now`. */
  now?: () => number
  /**
   * Which artwork the system's controls may load, by URL, asked each time the track changes: the
   * web app passes its own rule, so they never load an image its policy doesn't allow, nor
   * Spotify's while Spotify is switched off. Default: every image.
   */
  showImage?: (url: string) => boolean
}

/** The default seek step of the backward and forward actions, in milliseconds. */
export const MEDIA_SESSION_SEEK_OFFSET_MS = 10_000

/** Every artwork size as a Media Session image, with its size where the source gave one. */
export function mediaImages(artwork: readonly Artwork[]): MediaImage[] {
  return artwork.map(({ url, width, height }) =>
    width !== undefined && height !== undefined && width > 0 && height > 0
      ? { src: url, sizes: `${width}x${height}` }
      : { src: url },
  )
}

/**
 * The Media Session metadata for `track`: title, artists, album and every artwork size, or only
 * those `showImage` allows.
 */
export function mediaMetadataInit(
  track: Track,
  showImage: (url: string) => boolean = () => true,
): MediaMetadataInit {
  return {
    title: track.title,
    artist: track.artists.map((artist) => artist.name).join(', '),
    album: track.album?.name ?? '',
    artwork: mediaImages(track.artwork.filter((image) => showImage(image.url))),
  }
}

/** What the system controls should show for each player status. */
function playbackStateOf(status: PlayerStatus): MediaSessionPlaybackState {
  if (status === 'playing' || status === 'loading') return 'playing'
  return status === 'idle' ? 'none' : 'paused'
}

function defaultSession(): MediaSession | undefined {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator
    ? navigator.mediaSession
    : undefined
}

function defaultCreateMetadata(): ((init: MediaMetadataInit) => MediaMetadata) | undefined {
  return typeof MediaMetadata === 'function' ? (init) => new MediaMetadata(init) : undefined
}

/** Sets one action handler; browsers throw for actions they do not support. */
function setHandler(
  session: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
): void {
  try {
    session.setActionHandler(action, handler)
  } catch {
    // This browser does not support the action.
  }
}

/**
 * Connects `player` to the Media Session: keeps the metadata, the playback state and the
 * position up to date, and routes play, pause, previous, next, seek, seek backward/forward
 * (10 s by default) and stop to the player. Position updates are spaced at least
 * `positionIntervalMs` apart during playback, and sent at once after a seek, a track change or
 * a change of status or duration.
 *
 * Returns a function that disconnects it again and clears the session. Does nothing where the
 * browser has no Media Session API.
 */
export function connectMediaSession(
  player: MediaSessionPlayer,
  options: MediaSessionOptions = {},
): () => void {
  const session = options.session ?? defaultSession()
  if (session === undefined) return () => {}
  const createMetadata = options.createMetadata ?? defaultCreateMetadata()
  const seekOffsetMs = options.seekOffsetMs ?? MEDIA_SESSION_SEEK_OFFSET_MS
  const intervalMs = options.positionIntervalMs ?? 1000
  const now = options.now ?? Date.now
  const showImage = options.showImage

  const offsetOf = (details: MediaSessionActionDetails) =>
    details.seekOffset !== undefined && details.seekOffset > 0
      ? details.seekOffset * 1000
      : seekOffsetMs
  const handlers: Record<FxmMediaSessionAction, MediaSessionActionHandler> = {
    play: () => void player.play(),
    pause: () => player.pause(),
    previoustrack: () => void player.previous(),
    nexttrack: () => void player.next(),
    seekto: (details) => {
      if (details.seekTime !== undefined) player.seek(details.seekTime * 1000)
    },
    seekbackward: (details) => player.seekBy(-offsetOf(details)),
    seekforward: (details) => player.seekBy(offsetOf(details)),
    stop: () => player.stop(),
  }
  for (const action of MEDIA_SESSION_ACTIONS) setHandler(session, action, handlers[action])

  let shownTrack: Track | undefined
  let shownUid: number | undefined
  let positionSentAt = Number.NEGATIVE_INFINITY

  /** The metadata for `track`; without artwork if the browser rejects an image URL. */
  const metadataFor = (track: Track | undefined): MediaMetadata | null => {
    if (track === undefined || createMetadata === undefined) return null
    const init = mediaMetadataInit(track, showImage)
    try {
      return createMetadata(init)
    } catch {
      try {
        return createMetadata({ ...init, artwork: [] })
      } catch {
        return null
      }
    }
  }

  const sendPosition = (state: PlayerState) => {
    positionSentAt = now()
    if (typeof session.setPositionState !== 'function') return
    const { durationMs, positionMs } = state
    try {
      if (
        durationMs === undefined ||
        !(durationMs > 0) ||
        currentQueueItem(state.queue) === undefined
      ) {
        session.setPositionState()
        return
      }
      const duration = durationMs / 1000
      const position = Math.min(Math.max(positionMs / 1000, 0), duration)
      // A speed the browser can't take (0, say) would make it reject the whole state.
      const playbackRate = state.playbackRate > 0 ? state.playbackRate : 1
      session.setPositionState({ duration, playbackRate, position })
    } catch {
      // The browser rejected the values; the next update tries again.
    }
  }

  const update = (state: PlayerState, previous?: PlayerState) => {
    const item = currentQueueItem(state.queue)
    let immediate = previous === undefined
    if (item?.uid !== shownUid || item?.track !== shownTrack) {
      shownUid = item?.uid
      if (item?.track !== shownTrack) {
        shownTrack = item?.track
        session.metadata = metadataFor(shownTrack)
      }
      immediate = true
    }
    const playbackState = playbackStateOf(state.status)
    if (session.playbackState !== playbackState) {
      session.playbackState = playbackState
      immediate = true
    }
    if (state.durationMs !== previous?.durationMs) immediate = true
    // The system extrapolates the position at the speed it was told: tell it at once.
    if (state.playbackRate !== previous?.playbackRate) immediate = true
    if (immediate) sendPosition(state)
    else if (state.positionMs !== previous?.positionMs && now() - positionSentAt >= intervalMs) {
      sendPosition(state)
    }
  }

  const unsubscribe = player.subscribe((state, previous) => update(state, previous))
  const offSeek = player.on('seek', () => sendPosition(player.getState()))
  update(player.getState())

  return () => {
    unsubscribe()
    offSeek()
    for (const action of MEDIA_SESSION_ACTIONS) setHandler(session, action, null)
    session.metadata = null
    session.playbackState = 'none'
    try {
      session.setPositionState?.()
    } catch {
      // Nothing to clear.
    }
  }
}
