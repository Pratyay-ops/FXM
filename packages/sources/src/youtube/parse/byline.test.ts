import { describe, expect, it } from 'vitest'
import { BUNDLED_YOUTUBE_CONFIG, labelsFor } from '../config'
import { parseByline } from './byline'
import type { Run } from './text'

const { itemTypes } = labelsFor(BUNDLED_YOUTUBE_CONFIG, 'en')

function link(text: string, browseId: string, pageType: string): Run {
  return {
    text,
    endpoint: {
      browseEndpoint: {
        browseId,
        browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType } },
      },
    },
  }
}
const artist = (name: string, id = 'UCr_iyUANcn9OX_yy9piYoLw') =>
  link(name, id, 'MUSIC_PAGE_TYPE_ARTIST')
const album = (name: string, id = 'MPREb_DciERiuADkS') => link(name, id, 'MUSIC_PAGE_TYPE_ALBUM')
const text = (value: string): Run => ({ text: value })
const dot = text(' • ')

describe('bylines', () => {
  it('reads each run by its page type: artist, album, then the duration', () => {
    expect(
      parseByline(
        [artist('Radiohead'), dot, album('Pablo Honey'), dot, text('3:59')],
        'ytm',
        itemTypes,
      ),
    ).toEqual({
      artists: [{ id: 'ytm:artist:UCr_iyUANcn9OX_yy9piYoLw', name: 'Radiohead' }],
      album: { id: 'ytm:album:MPREb_DciERiuADkS', name: 'Pablo Honey' },
      durationMs: 239_000,
      words: [],
    })
  })

  it('does not depend on the order or number of fields', () => {
    const reordered = parseByline(
      [
        text('Song'),
        dot,
        album('Pablo Honey'),
        dot,
        text('1993'),
        dot,
        artist('Radiohead'),
        dot,
        text('2.3B plays'),
      ],
      'ytm',
      itemTypes,
    )
    expect(reordered).toMatchObject({
      artists: [{ name: 'Radiohead' }],
      album: { name: 'Pablo Honey' },
      year: 1993,
      words: ['Song'],
    })
    expect(reordered).not.toHaveProperty('durationMs')
  })

  it('keeps every linked artist, in order and without repeats, channels included', () => {
    const byline = parseByline(
      [
        artist('Virginia Bocelli', 'UC0A3CRJdM6rfSlWtL16OPmQ'),
        text(', '),
        artist('Matteo Bocelli', 'UCMS8xRalYk1dIY6yZQZseKA'),
        text(' & '),
        link('Andrea Bocelli', 'UCN0yeXZgAizy8VhiLj0-tIg', 'MUSIC_PAGE_TYPE_USER_CHANNEL'),
        text(' & '),
        artist('Virginia Bocelli', 'UC0A3CRJdM6rfSlWtL16OPmQ'),
      ],
      'ytm',
      itemTypes,
    )
    expect(byline.artists.map((a) => a.name)).toEqual([
      'Virginia Bocelli',
      'Matteo Bocelli',
      'Andrea Bocelli',
    ])
  })

  it('names unlinked artists only when no artist is linked, never type labels or counts', () => {
    expect(
      parseByline([text('Single'), dot, text('Some Band'), dot, text('2014')], 'ytm', itemTypes),
    ).toEqual({
      artists: [{ name: 'Some Band' }],
      words: ['Single', 'Some Band'],
      year: 2014,
    })
    expect(
      parseByline(
        [artist('Radiohead'), dot, text('Unlinked Guest'), dot, text('12K views')],
        'ytm',
        itemTypes,
      ).artists,
    ).toEqual([{ id: 'ytm:artist:UCr_iyUANcn9OX_yy9piYoLw', name: 'Radiohead' }])
    expect(
      parseByline([text('Artist'), dot, text('205M monthly audience')], 'ytm', itemTypes).artists,
    ).toEqual([])
  })

  it('reads plain YouTube’s channel links and gives them the source asked for', () => {
    const channel: Run = {
      text: 'Radiohead',
      endpoint: {
        commandMetadata: { webCommandMetadata: { webPageType: 'WEB_PAGE_TYPE_CHANNEL' } },
        browseEndpoint: { browseId: 'UCq19-LqvG35A-30oyAiPiqA' },
      },
    }
    expect(parseByline([channel], 'yt', itemTypes).artists).toEqual([
      { id: 'yt:artist:UCq19-LqvG35A-30oyAiPiqA', name: 'Radiohead' },
    ])
  })

  it('keeps names whose link is malformed, without an ID, and ignores other links', () => {
    const byline = parseByline(
      [
        artist('Broken', 'not-a-channel'),
        dot,
        album('Odd', 'XYZ'),
        dot,
        link('A playlist', 'VLPL1', 'MUSIC_PAGE_TYPE_PLAYLIST'),
      ],
      'ytm',
      itemTypes,
    )
    expect(byline).toEqual({ artists: [{ name: 'Broken' }], album: { name: 'Odd' }, words: [] })
  })
})
