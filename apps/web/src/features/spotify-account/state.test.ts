import { describe, expect, it } from 'vitest'
import { testRepo } from '../../test/library-fixtures'
import { sanitizeHomeCopy } from './home'
import { HOME_KEY, listKey, META_KEY, playlistCopyId } from './ids'
import {
  countCopies,
  forgetLists,
  forgetState,
  readMeta,
  readState,
  sanitizeList,
  sanitizeMeta,
  sanitizeSummary,
  writeList,
  writeMeta,
} from './state'
import { nativeId, spotifyTrack } from './testing'

const ACCOUNT = 'abcdefghijklmnopqrstuv'
const P1 = nativeId('p', 1)

const list = {
  local: playlistCopyId(P1),
  base: [nativeId('t', 1), nativeId('t', 2)],
  name: 'Road trip',
  description: 'Loud',
  artwork: 'https://i.scdn.co/image/x',
  revision: 'rev-1',
  written: 5,
}

describe('the state', () => {
  it('round-trips through the library', async () => {
    const repo = testRepo()
    await writeMeta(repo, { account: ACCOUNT, lastSyncAt: 7 })
    await writeList(repo, P1, list)
    await writeList(repo, 'liked', { ...list, local: playlistCopyId(nativeId('p', 9)) })
    const state = await readState(repo)
    expect(state.meta).toEqual({ account: ACCOUNT, lastSyncAt: 7 })
    expect(state.lists.get(P1)).toEqual(list)
    await forgetLists(repo, [P1])
    expect([...(await readState(repo)).lists.keys()]).toEqual(['liked'])
    await forgetLists(repo)
    expect((await readState(repo)).lists.size).toBe(0)
  })

  it("reads the sync's own row alone, and counts the copies without reading each whole", async () => {
    const repo = testRepo()
    expect(await readMeta(repo)).toBeUndefined()
    await writeMeta(repo, { account: ACCOUNT, lastSyncAt: 7 })
    expect(await readMeta(repo)).toEqual({ account: ACCOUNT, lastSyncAt: 7 })
    await writeList(repo, P1, list)
    await writeList(repo, 'liked', { ...list, local: playlistCopyId(nativeId('p', 9)) })
    await writeList(repo, nativeId('p', 2), {
      ...list,
      local: playlistCopyId(nativeId('p', 2)),
      dismissed: true,
    })
    await repo.putSettings({ [listKey(nativeId('p', 3))]: { local: 'local:playlist:mine' } })
    expect(await countCopies(repo)).toBe(2)
  })

  it('forgets all of it at once, the personal home included', async () => {
    const repo = testRepo()
    await writeMeta(repo, { account: ACCOUNT })
    await writeList(repo, P1, list)
    await repo.putSettings({ [HOME_KEY]: { account: ACCOUNT, at: 1, shelves: [] }, other: 1 })
    await forgetState(repo)
    expect(await repo.getSettings('spotify-account.')).toEqual(new Map())
    expect(await repo.getSetting('other')).toBe(1)
  })

  it('reads rows from a damaged backup as missing, field by field', async () => {
    expect(sanitizeMeta({ account: 'fixture-user' })).toBeUndefined()
    expect(sanitizeSummary({ at: 3, likedCopy: 'yes', pending: -2, complete: true })).toEqual({
      at: 3,
      likedCopy: false,
      likedCount: 0,
      playlistCount: 0,
      created: 0,
      updated: 0,
      added: 0,
      removed: 0,
      dismissed: 0,
      departed: 0,
      skipped: 0,
      pending: 0,
      home: false,
      complete: true,
    })
    expect(sanitizeMeta({ account: ACCOUNT, lastSyncAt: -1, last: { at: 'x' } })).toEqual({
      account: ACCOUNT,
    })
    expect(sanitizeList({ ...list, local: 'local:playlist:mine' })).toBeUndefined()
    expect(sanitizeList({ ...list, base: ['not an id'] })).toBeUndefined()
    expect(sanitizeList({ ...list, written: Number.NaN })).toBeUndefined()
    expect(sanitizeList({ ...list, artwork: 'javascript:alert(1)', dismissed: 'yes' })).toEqual({
      ...list,
      artwork: undefined,
    } as unknown as typeof list)
    expect(
      sanitizeList({ ...list, base: [nativeId('t', 1), nativeId('t', 1)], dismissed: true }),
    ).toMatchObject({ base: [nativeId('t', 1)], dismissed: true })
    const repo = testRepo()
    await repo.putSettings({ [META_KEY]: 'garbage', [listKey(P1)]: { local: 1 } })
    expect(await readState(repo)).toEqual({ lists: new Map() })
  })
})

describe('the kept home', () => {
  it('keeps only what Home can show', () => {
    const home = sanitizeHomeCopy({
      account: ACCOUNT,
      at: 10,
      shelves: [
        {
          id: 'spotify:section:a',
          title: 'Made For You',
          subtitle: 'Mixes',
          items: [
            { type: 'track', track: spotifyTrack(1) },
            { type: 'track', track: { ...spotifyTrack(2), id: 'ytm:track:x' } },
            {
              type: 'album',
              album: {
                id: 'spotify:album:37i9dQZF1E8OvD4G5pVGhr',
                name: 'An album',
                artists: [{ name: 'Someone' }, { nope: true }],
                artwork: [{ url: 'http://insecure' }, { url: 'https://i.scdn.co/a', width: 64 }],
              },
            },
            {
              type: 'artist',
              artist: { id: 'spotify:artist:37i9dQZF1E8OvD4G5pVGhr', name: 'Them' },
            },
            {
              type: 'playlist',
              playlist: {
                id: 'spotify:playlist:37i9dQZF1E8OvD4G5pVGhr',
                name: 'Daily Mix 1',
                owner: { name: 'Spotify' },
              },
            },
            { type: 'video', video: {} },
          ],
        },
        { id: 'empty', title: 'Nothing', items: [{ type: 'track', track: null }] },
        'not a shelf',
      ],
    })
    expect(home?.shelves).toHaveLength(1)
    expect(home?.shelves[0]?.items.map((item) => item.type)).toEqual([
      'track',
      'album',
      'artist',
      'playlist',
    ])
    expect(home?.shelves[0]?.items[1]).toEqual({
      type: 'album',
      album: {
        id: 'spotify:album:37i9dQZF1E8OvD4G5pVGhr',
        source: 'spotify',
        name: 'An album',
        artists: [{ name: 'Someone' }],
        artwork: [{ url: 'https://i.scdn.co/a', width: 64 }],
      },
    })
    expect(sanitizeHomeCopy({ account: ACCOUNT, at: 'now', shelves: [] })).toBeUndefined()
    expect(sanitizeHomeCopy({ account: 'x', at: 1, shelves: [] })).toBeUndefined()
  })
})
