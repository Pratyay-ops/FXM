import { describe, expect, it } from 'vitest'
import { BACKUP_VERSION } from '../../db/backup'
import { SCHEMA_VERSION } from '../../db/database'
import { DOWNLOADS_PLAYLIST_ID } from '../../db/types'
import { track } from '../../test/library-fixtures'
import { canonicalJson, hashHex } from './canonical'
import {
  decodeSnapshot,
  type EncodedSnapshot,
  encodeSnapshot,
  MANIFEST_FILE,
  MAX_PART_BYTES,
  PART_FORMAT,
  parseManifest,
  SYNC_FORMAT,
  SYNC_FORMAT_VERSION,
  SyncFormatError,
} from './gist-format'
import type { SyncSnapshot } from './snapshot'
import {
  follow,
  like,
  liked,
  order,
  P,
  pin,
  play,
  playlist,
  snap,
  trackRecord,
} from './testing/snapshots'

const meta = { revision: 'a1b2c3d4e5f60718', ancestors: ['0011223344556677'], savedAt: new Date(0) }

/** Every file of an encoded snapshot, by name, as a gist would hold them. */
function files(encoded: EncodedSnapshot): Map<string, string> {
  return new Map([...encoded.parts, [MANIFEST_FILE, encoded.manifestText]])
}

function decode(encoded: EncodedSnapshot, map = files(encoded)) {
  const manifest = parseManifest(map.get(MANIFEST_FILE))
  return decodeSnapshot(manifest, (name) => {
    const content = map.get(name)
    return content === undefined ? undefined : { content }
  })
}

function rich(): SyncSnapshot {
  return snap({
    tracks: [trackRecord(1), trackRecord(2), trackRecord(3)],
    likes: [like(1), like(3)],
    playlists: [liked([3, 1]), playlist('Mix', [2, 1, 3], { description: 'Mine' })],
    order: order([P('Mix')]),
    follows: [follow('Band')],
    history: [play(1, Date.UTC(2026, 9, 1)), play(2, Date.UTC(2026, 9, 2))],
    settings: [{ key: 'volume', value: 0.5, updatedAt: 5 }],
    pins: [pin('a', 'x')],
    appSettings: { catalogMode: 'all', theme: 'light' },
  })
}

function failure(run: () => unknown): SyncFormatError {
  try {
    run()
  } catch (error) {
    if (error instanceof SyncFormatError) return error
    throw error
  }
  throw new Error('Expected a SyncFormatError')
}

describe('encodeSnapshot and decodeSnapshot', () => {
  it('round-trip a library', () => {
    const snapshot = rich()
    const encoded = encodeSnapshot(snapshot, meta)
    const { snapshot: decoded, skipped } = decode(encoded)
    expect(decoded).toEqual(snapshot)
    expect(skipped).toBe(0)
  })

  it('describe the gist in the manifest', () => {
    const encoded = encodeSnapshot(rich(), meta)
    expect(encoded.manifest).toMatchObject({
      format: SYNC_FORMAT,
      version: SYNC_FORMAT_VERSION,
      revision: meta.revision,
      ancestors: meta.ancestors,
      schemaVersion: SCHEMA_VERSION,
      backupVersion: BACKUP_VERSION,
      appSettings: { catalogMode: 'all', theme: 'light' },
    })
    expect(parseManifest(encoded.manifestText)).toEqual(encoded.manifest)
    for (const part of encoded.manifest.parts) {
      expect(part.file).toMatch(new RegExp(`^fxm-${part.table}-.+-${part.hash}\\.json$`))
      const content = encoded.parts.get(part.file) ?? ''
      expect(JSON.parse(content)).toMatchObject({ format: PART_FORMAT, table: part.table })
      // Parts are canonical JSON.
      expect(canonicalJson(JSON.parse(content))).toBe(content)
    }
  })

  it('give the same parts for the same library, and new ones only where it changed', () => {
    const many = snap({
      tracks: Array.from({ length: 2000 }, (_, index) => trackRecord(index + 1)),
    })
    const first = encodeSnapshot(many, meta)
    const again = encodeSnapshot(many, { ...meta, revision: 'ffffffffffffffff' })
    expect([...again.parts.keys()]).toEqual([...first.parts.keys()])
    const tracksParts = first.manifest.parts.filter((part) => part.table === 'tracks')
    expect(tracksParts.length).toBeGreaterThan(4)

    const changed = snap({
      tracks: many.tracks.map((row) => (row.id === track(7).id ? trackRecord(7, 9999) : row)),
    })
    const after = encodeSnapshot(changed, meta)
    const before = new Set(first.parts.keys())
    const fresh = [...after.parts.keys()].filter((name) => !before.has(name))
    expect(fresh).toHaveLength(1)
  })

  it('keep every part under the size GitHub returns whole', () => {
    const big = snap({
      tracks: Array.from({ length: 6000 }, (_, index) => trackRecord(index + 1)),
      history: Array.from({ length: 12_000 }, (_, index) =>
        play((index % 50) + 1, Date.UTC(2026, 0, 1) + index * 3_600_000),
      ),
    })
    const encoded = encodeSnapshot(big, meta)
    for (const part of encoded.manifest.parts) {
      expect(part.bytes).toBeLessThanOrEqual(MAX_PART_BYTES)
      expect(new TextEncoder().encode(encoded.parts.get(part.file)).length).toBe(part.bytes)
    }
    expect(decode(encoded).snapshot).toEqual(big)
  })

  it('give the newest day of plays a part of its own, so a new play changes only it', () => {
    const day = (n: number) => Date.UTC(2026, 0, n, 12)
    const history = Array.from({ length: 40 }, (_, index) =>
      play(1, day(1 + Math.floor(index / 4)) + index),
    )
    const before = encodeSnapshot(snap({ history }), meta)
    const after = encodeSnapshot(snap({ history: [...history, play(2, day(10) + 1000)] }), meta)
    const oldParts = new Set(before.parts.keys())
    const fresh = [...after.parts.keys()].filter((name) => !oldParts.has(name))
    expect(fresh).toEqual([expect.stringMatching(/^fxm-history-d20260110-/)])
  })

  it('refuse a playlist too large for one file, naming it', () => {
    const huge = playlist(
      'Everything',
      Array.from({ length: 20_000 }, (_, index) => index + 1),
    )
    const error = failure(() => encodeSnapshot(snap({ playlists: [huge] }), meta))
    expect(error.code).toBe('too-large')
    expect(error.detail).toBe('the playlist “Everything”')
  })

  it('never carry Downloads, undo orders, unpinned decisions or invalid records', () => {
    const encoded = encodeSnapshot(rich(), meta)
    const map = files(encoded)
    const manifest = JSON.parse(map.get(MANIFEST_FILE) ?? '{}')
    // Rows another app put in, with the hashes updated so the parts still check out.
    const add = (table: string, rows: unknown[]) => {
      const entry = manifest.parts.find((part: { table: string }) => part.table === table)
      const data = JSON.parse(map.get(entry.file) ?? '{}')
      data.rows.push(...rows)
      const text = canonicalJson(data)
      map.set(entry.file, text)
      entry.hash = hashHex(text)
    }
    add('playlists', [
      { ...playlist('Downloads', [1]), id: DOWNLOADS_PLAYLIST_ID, system: 'downloads' },
      { ...playlist('Undo', [1, 2]), undo: { action: 'shuffle', order: [] } },
      { id: 'not an id' },
    ])
    add('matchCache', [{ ...pin('b', 'y'), userPinned: false }])
    map.set(MANIFEST_FILE, JSON.stringify(manifest))
    const { snapshot, skipped } = decode(encoded, map)
    expect(snapshot.playlists.map((item) => item.id)).not.toContain(DOWNLOADS_PLAYLIST_ID)
    expect(snapshot.playlists.find((item) => item.name === 'Undo')).not.toHaveProperty('undo')
    expect(snapshot.pins).toEqual(rich().pins)
    expect(skipped).toBe(1)
  })
})

describe('parseManifest', () => {
  const good = () => JSON.parse(encodeSnapshot(rich(), meta).manifestText)

  it('refuses a gist without a manifest, or another format', () => {
    expect(failure(() => parseManifest(undefined)).code).toBe('not-sync-gist')
    expect(failure(() => parseManifest(JSON.stringify({ format: 'other' }))).code).toBe(
      'not-sync-gist',
    )
  })

  it('refuses a gist from a newer FXM', () => {
    for (const change of [
      { version: SYNC_FORMAT_VERSION + 1 },
      { schemaVersion: SCHEMA_VERSION + 1 },
      { backupVersion: BACKUP_VERSION + 1 },
    ]) {
      expect(failure(() => parseManifest(JSON.stringify({ ...good(), ...change }))).code).toBe(
        'too-new',
      )
    }
  })

  it('refuses a damaged manifest', () => {
    expect(failure(() => parseManifest('{')).code).toBe('corrupt')
    expect(failure(() => parseManifest(JSON.stringify({ ...good(), revision: 'x' }))).code).toBe(
      'corrupt',
    )
    expect(
      failure(() => parseManifest(JSON.stringify({ ...good(), parts: [{ file: '../x' }] }))).code,
    ).toBe('corrupt')
    const twice = good()
    twice.parts.push(twice.parts[0])
    expect(failure(() => parseManifest(JSON.stringify(twice))).code).toBe('corrupt')
  })

  it('drops invalid ancestors and settings', () => {
    const manifest = parseManifest(
      JSON.stringify({ ...good(), ancestors: ['0011223344556677', 7, 'NOPE'], appSettings: [1] }),
    )
    expect(manifest.ancestors).toEqual(['0011223344556677'])
    expect(manifest.appSettings).toEqual({})
  })
})

describe('decodeSnapshot', () => {
  it('refuses a missing, truncated or changed part', () => {
    const encoded = encodeSnapshot(rich(), meta)
    const manifest = encoded.manifest
    const first = manifest.parts[0]?.file ?? ''
    const missing = (name: string) =>
      name === first ? undefined : { content: encoded.parts.get(name) }
    expect(failure(() => decodeSnapshot(manifest, missing)).code).toBe('corrupt')
    const truncated = (name: string) => ({
      content: encoded.parts.get(name),
      truncated: name === first,
    })
    expect(failure(() => decodeSnapshot(manifest, truncated)).code).toBe('corrupt')
    const changed = (name: string) => ({
      content:
        name === first
          ? (encoded.parts.get(name) ?? '').replace('"rows":[', '"rows":[{"x":1},')
          : encoded.parts.get(name),
    })
    expect(failure(() => decodeSnapshot(manifest, changed)).code).toBe('corrupt')
  })

  it('accepts a part whose whitespace changed on the way', () => {
    const encoded = encodeSnapshot(rich(), meta)
    const pretty = (name: string) => ({
      content: JSON.stringify(JSON.parse(encoded.parts.get(name) ?? '{}'), null, 2),
    })
    expect(decodeSnapshot(encoded.manifest, pretty).snapshot).toEqual(rich())
  })

  it('drops invalid records and counts them', () => {
    const snapshot = rich()
    const encoded = encodeSnapshot(
      { ...snapshot, likes: [...snapshot.likes, { key: 'x' } as never] },
      meta,
    )
    const { snapshot: decoded, skipped } = decode(encoded)
    expect(decoded.likes).toEqual(snapshot.likes)
    expect(skipped).toBe(1)
  })
})
