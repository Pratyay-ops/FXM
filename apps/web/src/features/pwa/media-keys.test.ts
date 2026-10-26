import { currentQueueItem } from '@fxm/core'
import { FakeEngine, testTrack, testTracks } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configurePlayback, getPlayer } from '../now-playing/playback'
import { FakePolicy } from '../now-playing/testing'

// The installed app's media keys: the app's player (stage 2.5) connects itself to the Media
// Session, which is how the keyboard's media keys, headset buttons, the lock screen and the
// system's media controls reach FXM, in a browser tab and in an installed window alike.

/** Records what the player does to the system's media controls. */
class FakeSession {
  metadata: MediaMetadataInit | null = null
  playbackState: MediaSessionPlaybackState = 'none'
  readonly handlers = new Map<string, MediaSessionActionHandler | null>()

  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    this.handlers.set(action, handler)
  }

  setPositionState(): void {}

  /** Presses a media key, as the system would. */
  press(action: MediaSessionAction): void {
    this.handlers.get(action)?.({ action })
  }
}

/** Puts a fake in place of `navigator.mediaSession` and `MediaMetadata`, which happy-dom lacks. */
function systemMediaSession(): FakeSession {
  const session = new FakeSession()
  Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true })
  vi.stubGlobal(
    'MediaMetadata',
    class {
      constructor(init: MediaMetadataInit) {
        Object.assign(this, init)
      }
    },
  )
  return session
}

/** Lets the player's pending promise chains finish. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'mediaSession')
})

describe('media keys', () => {
  it("reach the app's player, which shows its track in the system's controls", async () => {
    const session = systemMediaSession()
    // The app's own playback, as main.tsx gets it, on a fake engine and policy.
    configurePlayback({
      createEngine: () => new FakeEngine(),
      policy: new FakePolicy(),
      player: { retryDelaysMs: [0], stallTimeoutMs: 0 },
    })
    const player = getPlayer()

    await player.setQueue([
      testTrack('First', { album: { name: 'Album' } }),
      ...testTracks('Second'),
    ])

    expect(session.metadata).toMatchObject({ title: 'First', album: 'Album' })
    expect(session.playbackState).toBe('playing')

    session.press('pause')
    expect(player.getState().status).toBe('paused')

    session.press('nexttrack')
    await flush()
    expect(currentQueueItem(player.getState().queue)?.track.title).toBe('Second')
    expect(session.metadata).toMatchObject({ title: 'Second' })
  })
})
