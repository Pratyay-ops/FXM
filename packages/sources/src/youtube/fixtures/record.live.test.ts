/**
 * Records the fixtures in this folder from the live InnerTube, through the providers themselves,
 * so that every fixture answers exactly the request a provider sends. It runs only with both
 * `FXM_LIVE=1` and `FXM_RECORD=1`, makes 29 requests, and overwrites the fixtures when Vitest
 * updates snapshots (`-t <test name>` records one group only):
 *
 * ```sh
 * FXM_LIVE=1 FXM_RECORD=1 scripts/run.sh pnpm vitest run packages/sources/src/youtube/fixtures/record -u
 * make format   # Biome formats the new JSON
 * ```
 *
 * Every response goes through `sanitizeResponse` (see `sanitize.ts`) before it is written. Run it
 * from a residential connection: datacenter IPs get bot checks.
 */

import { type EntityId, formatId, isFxmError, type Track } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { createYouTubeProviders } from '../index'
import { KEPT_ITEMS, sanitizeResponse, truncateItems } from './sanitize'
import { context, FULL } from './testing'

/** Node's environment, read without Node's types (this package type-checks as a web worker). */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const recording = env?.FXM_LIVE === '1' && env?.FXM_RECORD === '1'

/** One InnerTube exchange the recorder saw. */
interface Capture {
  readonly endpoint: string
  readonly body: Record<string, unknown>
  readonly json: unknown
}

describe.skipIf(!recording)('recording the YouTube fixtures', { timeout: 120_000 }, () => {
  const captures: Capture[] = []
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init)
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.startsWith('/youtubei/v1/') && typeof init?.body === 'string') {
      captures.push({
        endpoint: url.pathname.slice('/youtubei/v1/'.length),
        body: JSON.parse(init.body) as Record<string, unknown>,
        json: JSON.parse(await response.clone().text()) as unknown,
      })
    }
    return response
  }
  const { music, video } = createYouTubeProviders()
  const all = context(recordingFetch, { mode: 'all', capabilities: FULL })
  const musicMode = context(recordingFetch, { mode: 'music', capabilities: FULL })

  /**
   * Writes the latest capture that `pick` selects as `<name>.json`, sanitized, and with its lists
   * of items cut to `KEPT_ITEMS[name]`.
   */
  async function save(name: string, pick: (capture: Capture) => boolean): Promise<void> {
    const capture = captures.findLast(pick)
    expect(capture, `a response for ${name}`).toBeDefined()
    const clean = sanitizeResponse(capture?.json)
    const kept = KEPT_ITEMS[name]
    const data = kept === undefined ? clean : truncateItems(clean, kept)
    await expect(`${JSON.stringify(data, null, 2)}\n`).toMatchFileSnapshot(`./${name}.json`)
  }

  const where =
    (endpoint: string, fields: Record<string, unknown>) =>
    (capture: Capture): boolean =>
      capture.endpoint === endpoint &&
      Object.entries(fields).every(([key, value]) => capture.body[key] === value)
  const config = music.session.config
  const clientName = (capture: Capture): unknown =>
    (capture.body.context as { client?: { clientName?: unknown } } | undefined)?.client?.clientName

  it('records searches', async () => {
    const songs = await music.search('Radiohead Creep', { types: ['track'] }, all)
    await save('search-songs', where('search', { params: config.search.music.songs }))
    const cursor = songs.tracks?.nextCursor
    expect(cursor).toBeDefined()
    await music.search('Radiohead Creep', { types: ['track'], cursor: cursor ?? '' }, all)
    await save(
      'search-songs-2',
      (capture) => capture.endpoint === 'search' && 'continuation' in capture.body,
    )
    await music.search('Radiohead Creep', { types: ['video'] }, all)
    await save('search-videos', where('search', { params: config.search.music.videos }))
    await music.search('Radiohead', { types: ['album', 'artist', 'playlist'] }, all)
    await save('search-albums', where('search', { params: config.search.music.albums }))
    await save('search-artists', where('search', { params: config.search.music.artists }))
    await save('search-playlists', where('search', { params: config.search.music.playlists }))
    await music.suggest('radioh', all)
    await save('suggest', where('music/get_search_suggestions', { input: 'radioh' }))
    await video.search('Radiohead Creep', { types: ['video'] }, all)
    await save('web-search-videos', where('search', { params: config.search.web.videos }))
    await video.search('Radiohead', { types: ['artist', 'playlist'] }, all)
    await save('web-search-channels', where('search', { params: config.search.web.channels }))
    await save('web-search-playlists', where('search', { params: config.search.web.playlists }))
  })

  it('records an album, its audio playlist, an artist and playlists', async () => {
    const album = await music.getAlbum(formatId('ytm', 'album', 'MPREb_DciERiuADkS'), musicMode)
    expect(album.tracks?.length).toBe(12)
    await save('album-pablo-honey', where('browse', { browseId: 'MPREb_DciERiuADkS' }))
    await save(
      'playlist-olak-pablo-honey',
      (capture) =>
        capture.endpoint === 'browse' && String(capture.body.browseId).startsWith('VLOLAK5uy_'),
    )
    await music.getArtist(formatId('ytm', 'artist', 'UCr_iyUANcn9OX_yy9piYoLw'), all)
    await save('artist-radiohead', where('browse', { browseId: 'UCr_iyUANcn9OX_yy9piYoLw' }))
    await video.getArtist(formatId('yt', 'artist', 'UCBHyEuwczfD-exAYApo_g6w'), all)
    await save('channel-uploader', where('browse', { browseId: 'UCBHyEuwczfD-exAYApo_g6w' }))
    await music.getPlaylist(formatId('ytm', 'playlist', 'PLNfe5eb0vdozpNx650kvCDhFjteIpW-L2'), all)
    await save(
      'playlist-b-sides',
      where('browse', { browseId: 'VLPLNfe5eb0vdozpNx650kvCDhFjteIpW-L2' }),
    )
    const big = formatId('ytm', 'playlist', 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI')
    const first = await music.getPlaylist(big, all)
    await save(
      'playlist-popular',
      where('browse', { browseId: 'VLPLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI' }),
    )
    await music.getPlaylistTracks(big, { cursor: first.tracks?.nextCursor ?? '' }, all)
    await save(
      'playlist-popular-2',
      (capture) => capture.endpoint === 'browse' && 'continuation' in capture.body,
    )
  })

  it('records tracks and radios', async () => {
    const creep = await music.getTrack(formatId('ytm', 'track', 'zFYEYRcjK2g'), musicMode)
    await save('next-creep-song', where('next', { videoId: 'zFYEYRcjK2g' }))
    await music.getTrack(formatId('ytm', 'track', 'XFkzRNyygfk'), all)
    await save('next-creep-video', where('next', { videoId: 'XFkzRNyygfk' }))
    await video.getTrack(formatId('yt', 'track', 'vX8ISGJXa8s'), all)
    await save('next-upload', where('next', { videoId: 'vX8ISGJXa8s' }))
    const radio = await music.radioPage(creep, {}, musicMode)
    await save('radio-creep', where('next', { playlistId: 'RDAMVMzFYEYRcjK2g' }))
    await music.radioPage(creep, { cursor: radio.nextCursor ?? '' }, musicMode)
    await save(
      'radio-creep-2',
      (capture) => capture.endpoint === 'next' && 'continuation' in capture.body,
    )
    const artist: { id: EntityId<'artist'>; name: string } = {
      id: formatId('ytm', 'artist', 'UCr_iyUANcn9OX_yy9piYoLw'),
      name: 'Radiohead',
    }
    await music.radioPage(artist, {}, musicMode)
    await save(
      'radio-artist',
      (capture) =>
        capture.endpoint === 'next' && String(capture.body.playlistId).startsWith('RDEM'),
    )
  })

  it('records the top result of an unfiltered search and a video description', async () => {
    await music.topResult('Radiohead Creep', all)
    await save(
      'search-top',
      (capture) =>
        capture.endpoint === 'search' &&
        capture.body.query === 'Radiohead Creep' &&
        capture.body.params === undefined,
    )
    await music.getDescription(formatId('ytm', 'track', 'zFYEYRcjK2g'), all)
    await save(
      'next-web-creep',
      (capture) =>
        capture.endpoint === 'next' &&
        capture.body.videoId === 'zFYEYRcjK2g' &&
        clientName(capture) === config.clients.web.name,
    )
  })

  it('records the answers to unknown IDs', async () => {
    const missing: Track['id'] = formatId('ytm', 'track', 'aaaaaaaaaaa')
    await expect(music.getTrack(missing, all)).rejects.toSatisfy((error) =>
      isFxmError(error, 'NotFound'),
    )
    await save('next-not-found', where('next', { videoId: 'aaaaaaaaaaa' }))
    await expect(
      music.getAlbum(formatId('ytm', 'album', 'MPREb_0000000000a'), all),
    ).rejects.toSatisfy((error) => isFxmError(error, 'NotFound'))
    await save('album-not-found', where('browse', { browseId: 'MPREb_0000000000a' }))
  })
})
