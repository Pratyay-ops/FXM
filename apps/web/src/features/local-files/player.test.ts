import { createQueue, formatId, isFxmError, type QueueItem, type Track } from '@fxm/core'
import type { ResolveRequest, StreamResolver } from '@fxm/player'
import { FakeEngine, testTrack } from '@fxm/player/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPlayer } from '../now-playing/playback'
import { FakePolicy, testCandidate } from '../now-playing/testing'
import { useSettingsStore } from '../settings/settings-store'
import { createLocalAudioSource } from './audio-source'
import { resetLocalFiles } from './local-files'
import {
  configureLocalPlayer,
  getLocalPlayer,
  localFileOf,
  onTrackFailed,
  resetLocalPlayer,
  withLocalFiles,
  withLocalFilesFirst,
} from './player'
import {
  asHandle,
  audioFile,
  fakeFolder,
  flacFile,
  installTestLocalFiles,
  m4aFile,
  mp3File,
  testLocalFiles,
} from './testing'
import { toTrack } from './tracks'

afterEach(async () => {
  resetLocalPlayer()
  await resetLocalFiles()
})

/** A facade with a scanned folder of a FLAC, an MP3 and an ALAC file. */
async function library(install = false) {
  const folder = fakeFolder('Music', {
    'night.flac': audioFile(
      flacFile({ tags: { title: 'Night Drive', isrc: 'USXYZ2100001' } }),
      'night.flac',
    ),
    'tide.mp3': audioFile(mp3File({ tags: { title: 'Slow Tide' } }), 'tide.mp3'),
    'echo.m4a': audioFile(m4aFile({ codec: 'alac', tags: { title: 'Echo' } }), 'echo.m4a'),
  })
  const pickDirectory = async () => asHandle(folder)
  const setup = install
    ? await installTestLocalFiles({ pickDirectory })
    : testLocalFiles({ pickDirectory })
  const result = await setup.files.addFolder()
  if (result.status !== 'added') throw new Error(result.status)
  await setup.files.whenScanned(result.root.id)
  const tracks = new Map<string, Track>()
  for (const file of await setup.files.repo.listFiles()) tracks.set(file.tags.title, toTrack(file))
  const track = (title: string) => {
    const found = tracks.get(title)
    if (found === undefined) throw new Error(`No ${title}`)
    return found
  }
  return { ...setup, folder, track }
}

function request(overrides: Partial<ResolveRequest> = {}): ResolveRequest {
  return {
    reason: 'play',
    attempt: 0,
    signal: new AbortController().signal,
    canPlay: () => 'probably',
    ...overrides,
  }
}

function item(track: Track, candidate?: QueueItem['candidate']): QueueItem {
  return candidate === undefined ? { uid: 0, track } : { uid: 0, track, candidate }
}

describe('withLocalFiles', () => {
  it('resolves local tracks to their file’s object URL, and the rest elsewhere', async () => {
    const { files, track } = await library()
    const fallback: StreamResolver = {
      resolve: vi.fn(async () => Promise.reject(new Error('elsewhere'))),
    }
    const resolver = withLocalFiles(fallback, () => files)
    const resolved = await resolver.resolve(item(track('Night Drive')), request())
    expect(resolved.stream).toMatchObject({
      url: expect.stringMatching(/^blob:/),
      codec: 'flac',
      tier: 'lossless',
    })
    expect(fallback.resolve).not.toHaveBeenCalled()
    await expect(resolver.resolve(item(testTrack('Remote')), request())).rejects.toThrow(
      'elsewhere',
    )
    expect(fallback.resolve).toHaveBeenCalledTimes(1)
  })

  it('follows the audio recorded on the item', async () => {
    const { files, track } = await library()
    const source = createLocalAudioSource(() => files)
    const [candidate] = await source.match(track('Night Drive'), {} as never)
    const fallback: StreamResolver = { resolve: vi.fn() }
    const resolver = withLocalFiles(fallback, () => files)
    // A catalog track whose recorded audio is a local file plays the file.
    if (candidate === undefined) throw new Error('No candidate')
    const resolved = await resolver.resolve(item(testTrack('Catalog'), candidate), request())
    expect(resolved.stream.codec).toBe('flac')
    // A local track whose recorded audio is elsewhere plays that instead.
    expect(localFileOf(item(track('Night Drive'), { ...candidate, source: 'ytm' }))).toBeUndefined()
  })

  it('refuses a format the engine can’t play as Unavailable, so the player skips it', async () => {
    const { files, track } = await library()
    const resolver = withLocalFiles({ resolve: vi.fn() }, () => files)
    const error = await resolver
      .resolve(
        item(track('Echo')),
        request({ canPlay: (stream) => (stream.codec === 'alac' ? 'no' : 'maybe') }),
      )
      .catch((failure: unknown) => failure)
    expect(isFxmError(error, 'Unavailable')).toBe(true)
    expect((error as Error).message).toBe('This browser can’t play ALAC files')
  })
})

describe('withLocalFilesFirst', () => {
  it('puts local files in front of a playback policy, and leaves the rest to it', async () => {
    const { files, track } = await library()
    const policy = new FakePolicy()
    const remote = testTrack('Remote')
    policy.alternativesOf.set(remote.id, [testCandidate('other')])
    const local = withLocalFilesFirst(policy, () => files)

    const own = await local.resolver.resolve(item(track('Night Drive')), request())
    const elsewhere = await local.resolver.resolve(item(remote), request())
    local.setPlayBestGuesses(true)

    expect(own.stream.codec).toBe('flac')
    expect(elsewhere.stream.url).toBe('https://media.test/Remote')
    // Only the catalog track reached the policy's resolver: nothing about local files did.
    expect(policy.resolver.log).toEqual(['Remote:play#0'])
    expect(policy.playBestGuesses).toBe(true)
    await expect(local.alternatives(remote, new AbortController().signal)).resolves.toEqual([
      testCandidate('other'),
    ])
  })
})

describe('the local audio source', () => {
  it('matches a local track to its own file, and a catalog track by ISRC', async () => {
    const { files, track } = await library()
    const source = createLocalAudioSource(() => files)
    const own = await source.match(track('Night Drive'), {} as never)
    expect(own).toEqual([
      expect.objectContaining({
        source: 'local',
        kind: 'song',
        title: 'Night Drive',
        confidence: 1,
      }),
    ])
    const catalog: Track = {
      ...testTrack('Night Drive'),
      id: formatId('spotify', 'track', '4uLU6hMCjMI75M1A2tKUQC'),
      source: 'spotify',
      isrc: 'USXYZ2100001',
    }
    const byIsrc = await source.match(catalog, {} as never)
    expect(byIsrc).toEqual([
      expect.objectContaining({
        source: 'local',
        evidence: ['isrc', 'local file'],
        signals: expect.objectContaining({ isrcVerified: true }),
      }),
    ])
    expect(await source.match({ ...catalog, isrc: 'GBAYE0601696' }, {} as never)).toEqual([])
    const { isrc: _isrc, ...withoutIsrc } = catalog
    expect(await source.match(withoutIsrc, {} as never)).toEqual([])
  })

  it('resolves a candidate to one stream, and refuses other sources', async () => {
    const { files, track } = await library()
    const source = createLocalAudioSource(() => files)
    const [candidate] = await source.match(track('Slow Tide'), {} as never)
    if (candidate === undefined) throw new Error('No candidate')
    const streams = await source.resolve(candidate, {} as never, {} as never)
    expect(streams).toEqual([
      expect.objectContaining({ codec: 'mp3', tier: 'normal', media: 'audio' }),
    ])
    const error = await source
      .resolve({ ...candidate, source: 'ytm' }, {} as never, {} as never)
      .catch((e: unknown) => e)
    expect(isFxmError(error, 'Unsupported')).toBe(true)
  })
})

describe('the local player', () => {
  it('plays local tracks through the player core from object URLs', async () => {
    const { track } = await library(true)
    const engine = new FakeEngine()
    configureLocalPlayer({ engine, mediaSession: false })
    await getLocalPlayer().setQueue([track('Night Drive'), track('Slow Tide')], {
      context: { type: 'library', id: 'local-files', title: 'Local files' },
    })
    expect(engine.source?.stream).toMatchObject({
      codec: 'flac',
      tier: 'lossless',
      url: expect.stringMatching(/^blob:/),
    })
    expect(getLocalPlayer().getState().status).toBe('playing')
    await getLocalPlayer().next()
    expect(engine.source?.stream).toMatchObject({ codec: 'mp3' })
  })

  it('tells listeners why a local track failed', async () => {
    const { track, folder } = await library(true)
    configureLocalPlayer({ engine: new FakeEngine(), mediaSession: false })
    const failures: string[] = []
    const stop = onTrackFailed(({ error }) => failures.push(error.message))
    folder.delete('night.flac')
    await getLocalPlayer().setQueue([track('Night Drive')])
    stop()
    expect(failures).toEqual(['“Night Drive” is no longer in “Music”'])
  })

  it('plays through the app’s player, which the player bars and Now playing show', () => {
    expect(getLocalPlayer()).toBe(getPlayer())
    const configured = configureLocalPlayer({ engine: new FakeEngine(), mediaSession: false })
    expect(getPlayer()).toBe(configured)
  })

  it('refuses anything that is not a local file where the music services don’t run', async () => {
    configureLocalPlayer({ engine: new FakeEngine(), mediaSession: false })
    const failures: Error[] = []
    const stop = onTrackFailed(({ error }) => failures.push(error))
    await getLocalPlayer().setQueue([testTrack('Remote')])
    stop()
    expect(isFxmError(failures[0], 'Unsupported')).toBe(true)
    expect(getLocalPlayer().getState().error?.reason).toBe('action-required')
  })

  it('keeps the queue’s catalog mode in step with the setting', async () => {
    const player = configureLocalPlayer({ engine: new FakeEngine(), mediaSession: false })
    expect(player.getState().queue.mode).toBe(createQueue().mode)
    useSettingsStore.getState().setCatalogMode('all')
    expect(player.getState().queue.mode).toBe('all')
  })
})
