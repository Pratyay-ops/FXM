import { FxmError, formatId, type Track } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { pickArtwork } from './cover-art'
import {
  albumTypeLabel,
  countLabel,
  formatDuration,
  formatTotalDuration,
  listKeys,
  releaseYear,
  totalDuration,
  trackKindLabel,
  uniqueById,
} from './format'
import { albumPath, artistPath, parseRouteId, playlistPath } from './links'
import { canRetry, errorMessage } from './states'

describe('links', () => {
  it('names an entity as <source>:<native ID> after its kind', () => {
    expect(albumPath(formatId('ytm', 'album', 'MPREb_abc'))).toBe('/album/ytm:MPREb_abc')
    expect(artistPath(formatId('spotify', 'artist', '0OdUWJ0sBjDrqHygGUXeCF'))).toBe(
      '/artist/spotify:0OdUWJ0sBjDrqHygGUXeCF',
    )
    expect(playlistPath(formatId('plugin.radio', 'playlist', 'a b/c?'))).toBe(
      '/playlist/plugin.radio:a%20b%2Fc%3F',
    )
  })

  it('reads a route parameter back into the same ID', () => {
    const id = formatId('archive', 'album', 'item:with:colons')
    // React Router hands over the parameter decoded.
    const param = decodeURIComponent(albumPath(id).slice('/album/'.length))
    expect(parseRouteId(param, 'album')).toBe(id)
    expect(parseRouteId('ytm:UC123', 'artist')).toBe('ytm:artist:UC123')
  })

  it.each([undefined, '', 'MPREb_abc', ':abc', 'ytm:', 'nope:abc', 'plugin.Bad:abc'])(
    'refuses the parameter %j',
    (param) => {
      expect(parseRouteId(param, 'album')).toBeNull()
    },
  )
})

describe('format', () => {
  it('formats track and total durations', () => {
    expect(formatDuration(225_000)).toBe('3:45')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
    expect(formatDuration(undefined)).toBeUndefined()
    expect(formatDuration(-1)).toBeUndefined()
    expect(formatTotalDuration(40_000)).toBe('40 sec')
    expect(formatTotalDuration(48 * 60_000)).toBe('48 min')
    expect(formatTotalDuration(65 * 60_000)).toBe('1 hr 5 min')
    expect(formatTotalDuration(120 * 60_000)).toBe('2 hr')
  })

  it('sums known durations only', () => {
    const tracks = [{ durationMs: 1000 }, {}, { durationMs: 2000 }] as Track[]
    expect(totalDuration(tracks)).toBe(3000)
    expect(totalDuration([{}] as Track[])).toBeUndefined()
  })

  it('labels kinds, album types, counts and years', () => {
    expect(trackKindLabel('song')).toBe('Song')
    expect(trackKindLabel('music-video')).toBe('Official video')
    expect(trackKindLabel('video')).toBe('Video')
    expect(albumTypeLabel('ep')).toBe('EP')
    expect(albumTypeLabel(undefined)).toBe('Album')
    expect(countLabel(1, 'song')).toBe('1 song')
    expect(countLabel(1200, 'song')).toBe('1,200 songs')
    expect(releaseYear('2013-05-17')).toBe('2013')
    expect(releaseYear(undefined)).toBeUndefined()
  })

  it('drops repeated entities, counting a ytm and a yt ID of one video as one', () => {
    const items = [
      { id: formatId('ytm', 'track', 'a') },
      { id: formatId('yt', 'track', 'a') },
      { id: formatId('ytm', 'track', 'b') },
    ]
    expect(uniqueById(items).map((item) => item.id)).toEqual(['ytm:track:a', 'ytm:track:b'])
  })

  it('gives repeated items distinct keys', () => {
    expect(listKeys([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'a' }])).toEqual([
      'a',
      'b',
      'a#2',
      'a#3',
    ])
  })
})

describe('pickArtwork', () => {
  const small = { url: 's', width: 60, height: 60 }
  const medium = { url: 'm', width: 226, height: 226 }
  const large = { url: 'l', width: 544, height: 544 }

  it('picks the smallest image that is sharp on a high-density screen', () => {
    expect(pickArtwork([large, small, medium], 48)?.url).toBe('m')
    expect(pickArtwork([large, small, medium], 224)?.url).toBe('l')
  })

  it('falls back to the largest image, and to nothing without images', () => {
    expect(pickArtwork([small, medium], 400)?.url).toBe('m')
    expect(pickArtwork([{ url: 'unsized' }, small], 48)?.url).toBe('unsized')
    expect(pickArtwork([], 48)).toBeUndefined()
  })
})

describe('errorMessage', () => {
  it('explains each failure in words, naming the source', () => {
    expect(errorMessage(new FxmError('Network', 'x'), 'ytm')).toBe(
      "Couldn't reach YouTube Music. Check your connection, then try again.",
    )
    expect(
      errorMessage(new FxmError('RateLimited', 'x', { retryAfterMs: 30_000 }), 'spotify'),
    ).toBe('Too many requests to Spotify for now. Try again in 30 seconds.')
    expect(errorMessage(new FxmError('RateLimited', 'x'), 'ytm')).toMatch(/in a minute/)
    expect(errorMessage(new FxmError('BotCheck', 'x'), 'ytm')).toMatch(/not a bot/)
    expect(errorMessage(new Error('boom'), 'ytm')).toBe('Something went wrong. Try again.')
  })

  it('offers no retry where it cannot help', () => {
    expect(canRetry(new FxmError('NotFound', 'x'))).toBe(false)
    expect(canRetry(new FxmError('Unsupported', 'x'))).toBe(false)
    expect(canRetry(new FxmError('Network', 'x'))).toBe(true)
    expect(canRetry(new Error('boom'))).toBe(true)
  })
})
