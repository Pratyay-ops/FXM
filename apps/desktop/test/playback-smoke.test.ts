import { candidateKey, FxmError, ownCandidate, type ProviderContext, parseId } from '@fxm/core'
import { FakeEngine, testContext } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopEnvironment } from '../bridge'
import {
  describeEnvironment,
  END_TOLERANCE_S,
  type PlaybackEnvironment,
  type PlaylistRun,
  type QueuePlayer,
  runPlaybackSteps,
  runProblem,
  type SmokePlaylist,
  youtubeFormat,
} from '../smoke/playback-steps'
import {
  ARCHIVE_DOWNLOAD,
  archiveFileSource,
  archiveTrack,
  archiveUrl,
  FREE_FILES,
  FREE_PLAYLIST,
  youtubeSongs,
} from '../smoke/playlists'
import { appQueuePlayer, type PlaybackSample } from '../smoke/queue-player'
import { type MediaPlayer, Pending, runSmoke, type StepResult } from '../smoke/steps'

const MAC_15: DesktopEnvironment = { os: 'macos', osVersion: '15.5.0', tray: false }

function environment(overrides: Partial<PlaybackEnvironment> = {}): PlaybackEnvironment {
  return {
    shell: MAC_15,
    canPlayType: { opus: 'probably', aac: 'probably' },
    mediaSession: true,
    webLocks: true,
    visibility: 'hidden',
    ...overrides,
  }
}

/** A run in which every track of `playlist` played in full. */
function fullRun(playlist: SmokePlaylist, overrides: Partial<PlaylistRun> = {}): PlaylistRun {
  return {
    tracks: playlist.tracks.map((track) => ({
      title: track.title,
      durationS: 30,
      playedS: 29.9,
      ended: true,
      codec: 'mp3',
    })),
    webLock: true,
    mediaSessionTitles: playlist.tracks.map((track) => track.title),
    visibility: ['hidden', 'hidden', 'hidden'],
    ...overrides,
  }
}

/** Runs the playback steps alone and collects their results. */
async function runSteps(options: Parameters<typeof runPlaybackSteps>[1]): Promise<StepResult[]> {
  const steps: StepResult[] = []
  await runPlaybackSteps(async (name, run) => {
    try {
      const [value, detail] = await run()
      steps.push({ name, status: 'passed', detail, ms: 0 })
      return value
    } catch (error) {
      const status = error instanceof Pending ? 'pending' : 'failed'
      steps.push({ name, status, detail: (error as Error).message, ms: 0 })
      return undefined
    }
  }, options)
  return steps
}

const player = (play: QueuePlayer['play']): QueuePlayer => ({ play })

describe('runPlaybackSteps', () => {
  it('passes with three full tracks in a row, and waits for the YouTube songs', async () => {
    const steps = await runSteps({
      environment: async () => environment(),
      playlists: [
        { label: 'YouTube Music songs', build: youtubeSongs },
        { label: FREE_PLAYLIST.label, build: async () => FREE_PLAYLIST },
      ],
      player: player(async (playlist) => fullRun(playlist)),
    })
    expect(steps.map((step) => [step.name, step.status])).toEqual([
      ['where the app runs', 'passed'],
      ['3 YouTube Music songs play to the end, one after another, hidden', 'pending'],
      ['3 Internet Archive tracks play to the end, one after another, hidden', 'passed'],
    ])
    expect(steps[0]?.detail).toContain('plays Opus 251')
    expect(steps[2]?.detail).toBe(
      '30.0 s + 30.0 s + 30.0 s of mp3, one after another; the Web Lock held while music ' +
        'played; the Media Session showed each title; page hidden',
    )
  })

  it('fails when the player gives up on a track', async () => {
    const steps = await runSteps({
      environment: async () => environment(),
      playlists: [{ label: 'tracks', build: async () => FREE_PLAYLIST }],
      player: player(async () => {
        throw new Error('gong failed: media error 4')
      }),
    })
    expect(steps[1]).toMatchObject({ status: 'failed', detail: 'gong failed: media error 4' })
  })

  it('refuses a playlist without exactly three tracks', async () => {
    const play = vi.fn()
    const steps = await runSteps({
      environment: async () => environment(),
      playlists: [{ label: 'tracks', build: async () => ({ ...FREE_PLAYLIST, tracks: [] }) }],
      player: player(play),
    })
    expect(steps[1]).toMatchObject({ status: 'failed', detail: 'the playlist has 0 tracks' })
    expect(play).not.toHaveBeenCalled()
  })

  it('fails the environment step when the shell does not answer', async () => {
    const steps = await runSteps({
      environment: async () => {
        throw new Error('no desktop_environment command')
      },
      playlists: [],
      player: player(async (playlist) => fullRun(playlist)),
    })
    expect(steps).toEqual([
      expect.objectContaining({ status: 'failed', detail: 'no desktop_environment command' }),
    ])
  })
})

describe('runProblem', () => {
  it('accepts three tracks that each played to their end', () => {
    expect(runProblem(fullRun(FREE_PLAYLIST), FREE_PLAYLIST)).toBeUndefined()
  })

  it('names the first track that did not play in full', () => {
    const run = fullRun(FREE_PLAYLIST)
    const [first, second, third] = run.tracks as [
      PlaylistRun['tracks'][0],
      PlaylistRun['tracks'][0],
      PlaylistRun['tracks'][0],
    ]
    const short = { ...second, playedS: second.durationS - END_TOLERANCE_S - 1 }
    expect(runProblem({ ...run, tracks: [first, short, third] }, FREE_PLAYLIST)).toBe(
      'plang pleng pling ended after 26.0 of 30.0 s',
    )
    const stopped = { ...third, ended: false, playedS: 12 }
    expect(runProblem({ ...run, tracks: [first, second, stopped] }, FREE_PLAYLIST)).toBe(
      'long temple bell stopped at 12.0 s',
    )
    const silent = { ...first, durationS: 0 }
    expect(runProblem({ ...run, tracks: [silent, second, third] }, FREE_PLAYLIST)).toBe(
      'gong had no duration',
    )
    expect(runProblem({ ...run, tracks: [first] }, FREE_PLAYLIST)).toBe('1 of 3 tracks played')
  })

  it('fails without the Web Lock, and with the wrong titles in the Media Session', () => {
    expect(runProblem(fullRun(FREE_PLAYLIST, { webLock: false }), FREE_PLAYLIST)).toBe(
      'the Web Lock was not held while music played',
    )
    expect(
      runProblem(fullRun(FREE_PLAYLIST, { mediaSessionTitles: ['gong', '', ''] }), FREE_PLAYLIST),
    ).toMatch(/^the Media Session showed/)
  })

  it('accepts a webview without Web Locks or a Media Session, which the report says', () => {
    const { webLock: _lock, mediaSessionTitles: _titles, ...bare } = fullRun(FREE_PLAYLIST)
    expect(runProblem(bare, FREE_PLAYLIST)).toBeUndefined()
  })
})

describe('youtubeFormat and describeEnvironment', () => {
  it('plays AAC 140 on macOS before 15.4, whatever WebKit claims', () => {
    const mac14 = environment({ shell: { os: 'macos', osVersion: '14.7.1', tray: true } })
    expect(youtubeFormat(mac14)).toBe('AAC 140')
  })

  it('plays Opus 251 where the webview is sure of it', () => {
    expect(youtubeFormat(environment())).toBe('Opus 251')
    const webview2 = environment({ shell: { os: 'windows', tray: true } })
    expect(youtubeFormat(webview2)).toBe('Opus 251')
  })

  it('falls back to AAC, then to what is left', () => {
    expect(youtubeFormat(environment({ canPlayType: { opus: '', aac: 'probably' } }))).toBe(
      'AAC 140',
    )
    expect(youtubeFormat(environment({ canPlayType: { opus: 'maybe', aac: '' } }))).toBe('Opus 251')
    expect(youtubeFormat(environment({ canPlayType: { opus: '', aac: '' } }))).toBe(
      'neither format',
    )
  })

  it('describes the webview in one line', () => {
    expect(
      describeEnvironment(environment({ shell: { ...MAC_15, webviewVersion: '620.2' } })),
    ).toBe(
      'macos 15.5.0, webview 620.2; canPlayType Opus "probably", AAC "probably": plays Opus ' +
        '251; Media Session yes, Web Locks yes; tray no, page hidden',
    )
  })
})

describe('the playlists', () => {
  it('plays three public-domain Internet Archive recordings, the longest first', () => {
    expect(FREE_PLAYLIST.tracks).toHaveLength(3)
    expect(FREE_PLAYLIST.tracks.map((track) => track.id)).toEqual([
      'archive:track:onomonopoetic_sounds/gong.mp3',
      'archive:track:onomonopoetic_sounds/plang_pleng_pling.mp3',
      'archive:track:long_temple_bell/long_temple_bell.mp3',
    ])
    const seconds = FREE_FILES.map((file) => file.seconds)
    expect(seconds).toEqual([...seconds].sort((a, b) => b - a))
  })

  it('resolves each file to its download URL, which nothing caps', async () => {
    const source = archiveFileSource()
    const track = archiveTrack('my item/a&b.mp3', 'a and b')
    const candidate = ownCandidate(track)
    expect(candidate?.source).toBe('archive')
    expect(parseId(track.id)?.nativeId).toBe('my item/a&b.mp3')
    const [stream] = await source.resolve(candidate as NonNullable<typeof candidate>, {
      ctx: testContext('full'),
      prefs: {} as never,
      rung: 'top',
      priority: 'playback',
      signal: new AbortController().signal,
    })
    expect(stream).toMatchObject({
      url: `${ARCHIVE_DOWNLOAD}my%20item/a%26b.mp3`,
      codec: 'mp3',
      ipBound: false,
      fullLength: 'unverified',
      protocol: 'progressive',
    })
    expect(archiveUrl('long_temple_bell/long_temple_bell.mp3')).toBe(
      'https://archive.org/download/long_temple_bell/long_temple_bell.mp3',
    )
    expect(candidateKey(candidate as NonNullable<typeof candidate>)).toContain('my item/a&b.mp3')
  })

  it('waits for stage 1.4 for the YouTube songs', async () => {
    await expect(youtubeSongs()).rejects.toBeInstanceOf(Pending)
  })
})

describe('appQueuePlayer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(sample: () => Promise<PlaybackSample> = async () => sampleOf()) {
    const engine = new FakeEngine()
    const connected = vi.fn()
    const disconnected = vi.fn()
    const queue = appQueuePlayer({
      context: (): ProviderContext => testContext('full', { platform: 'desktop' }),
      createEngine: () => engine,
      connect: (player) => {
        connected(player)
        return disconnected
      },
      sample,
    })
    return { engine, queue, connected, disconnected }
  }

  const sampleOf = (title = ''): PlaybackSample => ({
    webLock: true,
    mediaSessionTitle: title,
    visibility: 'hidden',
  })

  /** Plays each track the engine is given to its end, as a webview would. */
  async function playThrough(engine: FakeEngine, durationsMs: readonly number[]) {
    let previous: string | undefined
    for (const durationMs of durationsMs) {
      await vi.waitFor(
        () => {
          const url = engine.source?.stream.url
          if (url === undefined || url === previous) throw new Error('the next track is not loaded')
        },
        { interval: 5 },
      )
      previous = engine.source?.stream.url
      engine.emit('durationchange', durationMs)
      engine.progress(durationMs / 2)
      engine.progress(durationMs)
      engine.end()
    }
  }

  it('plays the three tracks in a row, muted, and reports each one', async () => {
    let titles = 0
    const { engine, queue, connected, disconnected } = setup(async () =>
      sampleOf(FREE_PLAYLIST.tracks[titles++]?.title),
    )
    const run = queue.play(FREE_PLAYLIST, { timeoutMs: 60_000 })
    await playThrough(engine, [64_200, 31_400, 27_000])
    await expect(run).resolves.toEqual({
      tracks: [
        { title: 'gong', durationS: 64.2, playedS: 64.2, ended: true, codec: 'mp3' },
        { title: 'plang pleng pling', durationS: 31.4, playedS: 31.4, ended: true, codec: 'mp3' },
        { title: 'long temple bell', durationS: 27, playedS: 27, ended: true, codec: 'mp3' },
      ],
      webLock: true,
      mediaSessionTitles: ['gong', 'plang pleng pling', 'long temple bell'],
      visibility: ['hidden', 'hidden', 'hidden'],
    })
    expect(engine.muted).toBe(true)
    expect(engine.loadedUrls).toEqual(FREE_FILES.map(({ file }) => archiveUrl(file)))
    expect(connected).toHaveBeenCalledOnce()
    expect(disconnected).toHaveBeenCalledOnce()
    expect(engine.destroyed).toBe(true)
  })

  it('rejects when a track fails for good', async () => {
    const { engine, queue, disconnected } = setup()
    const gone = () => Promise.reject(new FxmError('NotFound', 'gone'))
    const run = queue.play(
      { ...FREE_PLAYLIST, sources: [{ ...archiveFileSource(), resolve: gone }] },
      { timeoutMs: 60_000 },
    )
    await expect(run).rejects.toThrow(/^gong failed: /)
    expect(disconnected).toHaveBeenCalledOnce()
    expect(engine.destroyed).toBe(true)
  })

  it('rejects when the playlist runs out of time', async () => {
    vi.useFakeTimers()
    const { queue } = setup()
    const run = queue.play(FREE_PLAYLIST, { timeoutMs: 5000 })
    const settled = expect(run).rejects.toThrow(/^still playing after 5 s: gong/)
    await vi.advanceTimersByTimeAsync(5000)
    await settled
  })
})

describe('runSmoke with stage 7.3’s steps', () => {
  it('runs the extra steps last and counts their failures', async () => {
    const noFetch = async () => new Response('', { status: 500 })
    const ctx = testContext('full', { fetch: noFetch, platform: 'desktop' })
    const mediaPlayer: MediaPlayer = { playToEnd: async () => ({ durationS: 1 }) }
    const report = await runSmoke({
      context: () => ctx,
      capabilities: ctx.capabilities,
      youtube: { search: async () => ({ videoId: 'x' }), resolve: async () => [] },
      player: mediaPlayer,
      query: 'q',
      freeTrack: { url: 'https://archive.org/download/x/x.mp3', label: 'Free track' },
      now: () => 0,
      extraSteps: async (step) => {
        await step('a 7.3 step', async () => {
          throw new Error('no tray')
        })
      },
    })
    expect(report.steps.at(-1)).toMatchObject({ name: 'a 7.3 step', status: 'failed' })
    expect(report.ok).toBe(false)
  })
})
