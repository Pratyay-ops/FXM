import {
  type AudioCandidate,
  FxmError,
  formatId,
  type ProviderContext,
  type StreamOption,
  type Track,
} from '@fxm/core'
import type { OfflineStore } from '@fxm/player'
import { describe, expect, it, vi } from 'vitest'
import { firstOfflineCopy, localIsrcCopies } from './offline'

const ctx = { mode: 'music', platform: 'web' } as ProviderContext

const SPOTIFY: Track = {
  id: formatId('spotify', 'track', '70LcF31zb1H0PyJoS1Sx1r'),
  source: 'spotify',
  title: 'Creep',
  artists: [{ name: 'Radiohead' }],
  artwork: [],
  kind: 'song',
  isrc: 'GBAYE9200070',
}

function stream(url: string): StreamOption {
  return {
    url,
    codec: 'flac',
    container: 'flac',
    media: 'audio',
    tier: 'lossless',
    protocol: 'progressive',
    ipBound: false,
    fullLength: 'verified',
  }
}

const OWN_FILE: AudioCandidate = {
  source: 'local',
  ref: '0123456789abcdef',
  kind: 'song',
  title: 'Creep',
  artists: ['Radiohead'],
  confidence: 0.95,
  evidence: ['isrc', 'local file'],
  signals: { isrcVerified: true, sourceAlbumMatch: false },
}

describe('firstOfflineCopy', () => {
  it('plays the first copy found: downloads before the user’s own files', async () => {
    const downloads: OfflineStore = { find: vi.fn(async () => stream('blob:download')) }
    const files: OfflineStore = { find: vi.fn(async () => stream('blob:file')) }

    const found = await firstOfflineCopy([downloads, files]).find(SPOTIFY, ctx)

    expect(found?.url).toBe('blob:download')
    expect(files.find).not.toHaveBeenCalled()
  })

  it('skips a store that fails, and finds nothing when none has a copy', async () => {
    const broken: OfflineStore = { find: async () => Promise.reject(new Error('No database')) }
    const empty: OfflineStore = { find: async () => undefined }
    const files: OfflineStore = { find: async () => stream('blob:file') }

    expect((await firstOfflineCopy([broken, files]).find(SPOTIFY, ctx))?.url).toBe('blob:file')
    expect(await firstOfflineCopy([broken, empty]).find(SPOTIFY, ctx)).toBeUndefined()
  })
})

describe('localIsrcCopies', () => {
  it('plays the user’s own file tagged with the track’s ISRC', async () => {
    const files = {
      match: vi.fn(async () => [OWN_FILE]),
      resolve: vi.fn(async () => [stream('blob:own-copy')]),
    }

    const found = await localIsrcCopies(files).find(SPOTIFY, ctx)

    expect(found?.url).toBe('blob:own-copy')
    expect(files.match).toHaveBeenCalledWith(SPOTIFY, ctx)
    expect(files.resolve).toHaveBeenCalledWith(OWN_FILE, ctx, expect.anything())
  })

  it('opens nothing for a track without an ISRC, or a local track', async () => {
    const files = { match: vi.fn(async () => [OWN_FILE]), resolve: vi.fn(async () => []) }
    const { isrc: _isrc, ...withoutIsrc } = SPOTIFY

    expect(await localIsrcCopies(files).find(withoutIsrc, ctx)).toBeUndefined()
    expect(
      await localIsrcCopies(files).find(
        { ...SPOTIFY, id: formatId('local', 'track', '1'), source: 'local' },
        ctx,
      ),
    ).toBeUndefined()
    expect(files.match).not.toHaveBeenCalled()
  })

  it('streams instead when the file is gone or needs the user’s permission again', async () => {
    const files = {
      match: async () => [OWN_FILE],
      resolve: async () => Promise.reject(new FxmError('AuthRequired', 'Allow the folder again')),
    }

    expect(await localIsrcCopies(files).find(SPOTIFY, ctx)).toBeUndefined()
  })
})
