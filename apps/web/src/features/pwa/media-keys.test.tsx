import { currentQueueItem } from '@fxm/core'
import { type MediaSessionOptions, Player } from '@fxm/player'
import { FakeEngine, FakeResolver, testTrack, testTracks } from '@fxm/player/testing'
import { act, render, renderHook, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderApp } from '../../test/render'
import { type AppPlayerSource, appPlayerSource } from './integration'
import { useMediaKeys } from './media-keys'
import { PwaShell } from './pwa-shell'

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

function setup() {
  const session = new FakeSession()
  const player = new Player({ engine: new FakeEngine(), resolver: new FakeResolver() })
  const options: MediaSessionOptions = {
    session: session as unknown as MediaSession,
    createMetadata: (init) => init as unknown as MediaMetadata,
  }
  return { session, player, options }
}

/** Lets the player's pending promise chains finish. */
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

const playing = (player: Player) => currentQueueItem(player.getState().queue)?.track.title

/** Puts a fake in place of `navigator.mediaSession`, which happy-dom doesn't have. */
function systemMediaSession(session: FakeSession) {
  Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true })
}

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'mediaSession')
})

describe('useMediaKeys', () => {
  it("shows the player's track in the system controls and takes the media keys", async () => {
    const { session, player, options } = setup()
    renderHook(() => useMediaKeys(player, options))

    await act(() =>
      player.setQueue([testTrack('First', { album: { name: 'Album' } }), ...testTracks('Second')]),
    )

    expect(session.metadata).toMatchObject({
      title: 'First',
      artist: 'First artist',
      album: 'Album',
    })
    expect(session.playbackState).toBe('playing')

    session.press('pause')
    expect(player.getState().status).toBe('paused')
    expect(session.playbackState).toBe('paused')

    session.press('nexttrack')
    await flush()
    expect(playing(player)).toBe('Second')
    expect(session.metadata).toMatchObject({ title: 'Second' })
  })

  it('lets go of the media keys when the player goes', () => {
    const { session, player, options } = setup()
    const { rerender } = renderHook(({ current }) => useMediaKeys(current, options), {
      initialProps: { current: player as Player | undefined },
    })
    expect(session.handlers.get('play')).toBeTypeOf('function')

    rerender({ current: undefined })

    expect(session.handlers.get('play')).toBeNull()
    expect(session.playbackState).toBe('none')
  })

  it('connects nothing while there is no player', () => {
    const { session, options } = setup()
    renderHook(() => useMediaKeys(undefined, options))
    expect(session.handlers.size).toBe(0)
  })
})

describe('PwaShell', () => {
  it("connects the app's player to the media keys", async () => {
    const { session, player } = setup()
    systemMediaSession(session)
    vi.stubGlobal(
      'MediaMetadata',
      class {
        constructor(init: MediaMetadataInit) {
          Object.assign(this, init)
        }
      },
    )
    const players: AppPlayerSource = { usePlayer: () => player }
    const router = createMemoryRouter([
      { path: '/', element: <PwaShell title="Home" players={players} /> },
    ])
    render(<RouterProvider router={router} />)

    await act(() => player.setQueue(testTracks('Song')))

    expect(session.metadata).toMatchObject({ title: 'Song' })
    session.press('pause')
    expect(player.getState().status).toBe('paused')
  })

  it('has no player to connect until stage 2.5 provides one', async () => {
    const session = new FakeSession()
    systemMediaSession(session)
    expect(renderHook(() => appPlayerSource.usePlayer()).result.current).toBeUndefined()

    renderApp('/')
    await screen.findByRole('heading', { level: 1 })

    expect(session.handlers.size).toBe(0)
  })
})
