import { createQueue, formatId, jumpInQueue, setQueue, type Track } from '@fxm/core'
import type { PlayerState } from '@fxm/player'
import { describe, expect, it, vi } from 'vitest'
import type { EmbedEntity } from './catalog'
import type { EmbedState } from './controller'
import type { EmbedTarget } from './target'
import {
  ALBUM,
  ARCHIVE_ATTRIBUTION,
  ARCHIVE_TRACK,
  SONG_A,
  SONG_B,
  SONG_C,
  targetOf,
} from './testing/harness'
import {
  CREDIT_HOSTS,
  creditLink,
  creditOf,
  embedView,
  joinArtists,
  messageFor,
  pickArtwork,
  placeholderTitle,
  previewView,
  songCount,
} from './view'

const ORIGIN = 'https://fxmusic.pages.dev'
const ALBUM_TARGET = targetOf(ALBUM)

const albumEntity: EmbedEntity = {
  target: ALBUM_TARGET,
  title: ALBUM.name,
  artists: ALBUM.artists,
  artwork: ALBUM.artwork,
  tracks: [SONG_A, SONG_B, SONG_C],
  trackCount: 3,
}

function player(tracks: readonly Track[], index = 0, overrides: Partial<PlayerState> = {}) {
  const queue = jumpInQueue(setQueue(createQueue(), tracks), index)
  return {
    queue,
    status: 'paused',
    buffering: false,
    positionMs: 0,
    durationMs: undefined,
    volume: 1,
    muted: false,
    stream: undefined,
    error: undefined,
    playbackRate: 1,
    effects: { equalizer: 'off', loudness: 'off', loudnessGainDb: 0 },
    sleepTimer: undefined,
    ...overrides,
  } satisfies PlayerState
}

const view = (state: EmbedState, target: EmbedTarget = ALBUM_TARGET) =>
  embedView(state, {
    layout: 'card',
    target,
    origin: ORIGIN,
    attribution: (track) => (track.source === 'archive' ? ARCHIVE_ATTRIBUTION : undefined),
  })

describe('embedView', () => {
  it('shows skeletons while loading', () => {
    expect(view({ phase: 'loading' })).toEqual({
      layout: 'card',
      kind: 'album',
      loading: true,
      kindLabel: 'Album',
      artwork: [],
      seed: ALBUM.id,
      rows: [],
      currentIndex: -1,
      status: 'idle',
      buffering: false,
      positionMs: 0,
      canSkip: false,
      canPlay: false,
      links: {
        open: `${ORIGIN}/app/album/ytm:MPREb_album`,
        install: `${ORIGIN}/#get`,
      },
    })
  })

  it('shows an album with nothing current until it plays', () => {
    const ready = view({ phase: 'ready', entity: albumEntity, player: player(albumEntity.tracks) })
    expect(ready).toMatchObject({
      loading: false,
      title: ALBUM.name,
      subtitle: 'The Testers',
      kindLabel: 'Album · 3 songs',
      currentIndex: -1,
      status: 'idle',
      canSkip: true,
      canPlay: true,
      durationMs: 200_000,
    })
    expect(ready.now).toBeUndefined()
    expect(ready.rows).toEqual([
      { key: `0:${SONG_A.id}`, title: 'Song A', artists: 'The Testers', durationMs: 200_000 },
      { key: `1:${SONG_B.id}`, title: 'Song B', artists: 'The Testers', durationMs: 200_000 },
      { key: `2:${SONG_C.id}`, title: 'Song C', artists: 'The Testers', durationMs: 200_000 },
    ])

    const playing = view({
      phase: 'ready',
      entity: albumEntity,
      started: true,
      player: player(albumEntity.tracks, 1, {
        status: 'playing',
        positionMs: 5000,
        durationMs: 199_000,
      }),
    })
    expect(playing).toMatchObject({
      currentIndex: 1,
      now: { title: 'Song B', artists: 'The Testers' },
      status: 'playing',
      positionMs: 5000,
      durationMs: 199_000,
    })
  })

  it("shows a track without a list, and a free-source track's credits once it plays", () => {
    const target = targetOf(ARCHIVE_TRACK)
    const entity: EmbedEntity = {
      target,
      title: ARCHIVE_TRACK.title,
      artists: ARCHIVE_TRACK.artists,
      artwork: [],
      tracks: [ARCHIVE_TRACK],
      trackCount: 1,
    }
    const before = view({ phase: 'ready', entity, player: player([ARCHIVE_TRACK]) }, target)
    expect(before).toMatchObject({ kindLabel: 'Song', rows: [], canSkip: false })
    expect(before.attribution).toBeUndefined()
    const after = view(
      { phase: 'ready', entity, started: true, player: player([ARCHIVE_TRACK]) },
      target,
    )
    expect(after.attribution).toEqual(ARCHIVE_ATTRIBUTION)
    // A track has no page in the app: "Open in FXM" searches for it.
    expect(after.links.open).toBe(`${ORIGIN}/app/search?q=Side+A+Archive+Band`)
  })

  it('links credits only to the source and the licence', () => {
    const target = targetOf(ARCHIVE_TRACK)
    const entity: EmbedEntity = {
      target,
      title: ARCHIVE_TRACK.title,
      artists: ARCHIVE_TRACK.artists,
      artwork: [],
      tracks: [ARCHIVE_TRACK],
      trackCount: 1,
    }
    const credited = embedView(
      { phase: 'ready', entity, started: true, player: player([ARCHIVE_TRACK]) },
      {
        layout: 'card',
        target,
        origin: ORIGIN,
        attribution: () => ({
          provider: 'Internet Archive',
          pageUrl: 'https://archive.org/details/item',
          // An uploader's licence field, pointing somewhere else entirely.
          licenseUrl: 'ms-msdt:/id PCWDiagnostic',
        }),
      },
    )
    expect(credited.attribution).toEqual({
      provider: 'Internet Archive',
      pageUrl: 'https://archive.org/details/item',
    })
  })

  it("names unloaded content by its source and explains why it can't play", () => {
    const unavailable = view(
      { phase: 'unavailable', problem: 'needs-youtube' },
      { kind: 'track', id: SONG_A.id },
    )
    expect(unavailable).toMatchObject({
      title: 'A song from YouTube Music',
      canPlay: false,
      message: { kind: 'needs-youtube', action: 'install' },
    })
    expect(unavailable.message?.text).toMatch(/FXM Connect/)
  })

  it('shows the latest playback notice while ready', () => {
    const state: EmbedState = {
      phase: 'ready',
      entity: albumEntity,
      player: player(albumEntity.tracks),
      notice: 'failed',
    }
    expect(view(state).message).toEqual({
      kind: 'failed',
      text: "Couldn't play this. Try again.",
      short: "Couldn't play this. Try again.",
    })
    expect(view({ ...state, notice: 'bot-check' }).message?.action).toBe('open')
  })

  it("searches the app for a track once its title is known, and opens the app's home before", () => {
    const target = { kind: 'track', id: SONG_A.id } as const
    expect(view({ phase: 'unavailable', problem: 'needs-youtube' }, target).links.open).toBe(
      `${ORIGIN}/app/`,
    )
    const entity: EmbedEntity = {
      target,
      title: SONG_A.title,
      artists: SONG_A.artists,
      artwork: [],
      tracks: [SONG_A],
      trackCount: 1,
    }
    expect(view({ phase: 'unavailable', problem: 'hidden-by-mode', entity }, target).links).toEqual(
      {
        open: `${ORIGIN}/app/search?q=Song+A+The+Testers`,
        install: `${ORIGIN}/#get`,
      },
    )
  })
})

describe('previewView', () => {
  it('previews what the share dialog knows, ready to play', () => {
    const preview = previewView(
      ALBUM_TARGET,
      'compact',
      { title: 'X', tracks: [SONG_A, SONG_B] },
      ORIGIN,
    )
    expect(preview).toMatchObject({
      layout: 'compact',
      title: 'X',
      subtitle: '',
      kindLabel: 'Album · 2 songs',
      currentIndex: 0,
      now: { title: 'Song A', artists: 'The Testers' },
      status: 'idle',
      canSkip: true,
      canPlay: true,
      durationMs: 200_000,
    })
    const untracked = previewView(ALBUM_TARGET, 'card', { title: 'X', trackCount: 12 }, ORIGIN)
    expect(untracked.kindLabel).toBe('Album · 12 songs')
    // The app doesn't have its tracks: the preview shows placeholder rows.
    expect(untracked.placeholderRows).toBe(4)
    expect(preview.placeholderRows).toBeUndefined()
    expect(
      previewView({ kind: 'track', id: SONG_A.id }, 'card', { title: 'S' }, ORIGIN).placeholderRows,
    ).toBeUndefined()
  })
})

describe('helpers', () => {
  it('count songs and join artists', () => {
    expect(songCount(1)).toBe('1 song')
    expect(songCount(12)).toBe('12 songs')
    expect(joinArtists([])).toBe('')
    expect(joinArtists([{ name: 'A' }])).toBe('A')
    expect(joinArtists([{ name: 'A' }, { name: ' ' }, { name: 'B' }, { name: 'C' }])).toBe(
      'A, B & C',
    )
  })

  it('name unloaded content by its kind and source', () => {
    expect(placeholderTitle({ kind: 'track', id: formatId('yt', 'track', 'x') })).toBe(
      'A video from YouTube',
    )
    expect(placeholderTitle({ kind: 'album', id: formatId('jamendo', 'album', '1') })).toBe(
      'An album from Jamendo',
    )
    expect(placeholderTitle({ kind: 'playlist', id: formatId('archive', 'playlist', 'p') })).toBe(
      'A playlist from Internet Archive',
    )
  })

  it('has a message, with what helps, for every problem and notice', () => {
    const kinds = [
      'not-found',
      'needs-youtube',
      'hidden-by-mode',
      'empty',
      'unsupported',
      'failed',
      'bot-check',
      'unavailable',
    ] as const
    for (const kind of kinds) {
      const message = messageFor(kind, 'playlist')
      expect(message.kind).toBe(kind)
      expect(message.text.length).toBeGreaterThan(10)
      // Two lines at about 130 px in the compact layout.
      expect(message.short.length).toBeLessThanOrEqual(46)
      expect(['install', 'open', 'retry']).toContain(message.action)
    }
    expect(messageFor('not-found', 'track').text).toBe("This song isn't available.")
    expect(messageFor('empty', 'album').text).toBe('This album has nothing this player can play.')
  })

  it('names only FXM Connect for YouTube Music until an app is out, then the FXM app too', async () => {
    expect(messageFor('needs-youtube', 'track')).toMatchObject({
      text: "FXM can't reach YouTube Music in this browser. Add the free FXM Connect extension.",
      short: 'Needs FXM Connect to play here.',
    })
    // Once a release carries the desktop app (stage 7.5).
    vi.resetModules()
    vi.doMock('../features/connect/config', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../features/connect/config')>()
      return { ...actual, RELEASED: { ...actual.RELEASED, desktop: true } }
    })
    try {
      const { messageFor: released } = await import('./view')
      const message = released('needs-youtube', 'track')
      expect(message).toMatchObject({
        text: "FXM can't reach YouTube Music in this browser. Add the free FXM Connect extension, or get the FXM app.",
        short: 'Needs FXM Connect or the FXM app to play here.',
      })
      // Still two lines at most in the compact layout.
      expect(message.short.length).toBeLessThanOrEqual(46)
    } finally {
      vi.doUnmock('../features/connect/config')
      vi.resetModules()
    }
  })

  it.each([
    [
      'an Internet Archive page',
      'https://archive.org/details/item',
      'https://archive.org/details/item',
    ],
    ['a subdomain', 'https://ia800.us.archive.org/x', 'https://ia800.us.archive.org/x'],
    [
      'a deed over plain HTTP, upgraded',
      'http://creativecommons.org/licenses/by-nc-sa/3.0/',
      'https://creativecommons.org/licenses/by-nc-sa/3.0/',
    ],
    ['a Jamendo page', 'https://www.jamendo.com/track/1', 'https://www.jamendo.com/track/1'],
    ['javascript:', 'javascript:alert(1)', undefined],
    ['an app scheme', 'search-ms:query=x', undefined],
    ['an intent', 'intent://scan/#Intent;scheme=zxing;end', undefined],
    ['another site', 'https://evil.example/licence', undefined],
    ['a look-alike host', 'https://archive.org.evil.example/x', undefined],
    ['a host that only ends the same', 'https://notarchive.org/x', undefined],
    ['credentials', 'https://user:pass@archive.org/x', undefined],
    ['a port', 'https://archive.org:8443/x', undefined],
    ['plain HTTP elsewhere', 'http://evil.example/x', undefined],
    ['nothing', undefined, undefined],
    ['not a URL', 'licence', undefined],
  ])('links credits to %s only when it is the source or the licence', (_name, url, link) => {
    expect(creditLink(url)).toBe(link)
  })

  it('keeps the provider as text when its link is dropped', () => {
    expect(CREDIT_HOSTS).toEqual(['archive.org', 'jamendo.com', 'creativecommons.org'])
    expect(
      creditOf({ provider: 'Jamendo', pageUrl: 'javascript:alert(1)', licenseUrl: 'x:y' }),
    ).toEqual({ provider: 'Jamendo' })
  })

  it('picks the smallest artwork that fills the space, over HTTPS only', () => {
    const artwork = [
      { url: 'https://i.ytimg.com/a-544.jpg', width: 544 },
      { url: 'https://i.ytimg.com/a-60.jpg', width: 60 },
      { url: 'https://i.ytimg.com/a-226.jpg', width: 226 },
      { url: 'http://insecure.example/a-1000.jpg', width: 1000 },
    ]
    expect(pickArtwork(artwork, 96)).toBe('https://i.ytimg.com/a-226.jpg')
    expect(pickArtwork(artwork, 96, 3)).toBe('https://i.ytimg.com/a-544.jpg')
    expect(pickArtwork(artwork, 400, 2)).toBe('https://i.ytimg.com/a-544.jpg')
    expect(pickArtwork([{ url: 'https://x.example/a.jpg' }], 64)).toBe('https://x.example/a.jpg')
    expect(pickArtwork([{ url: 'data:image/png;base64,xx' }], 64)).toBeUndefined()
    expect(pickArtwork([], 64)).toBeUndefined()
  })
})
