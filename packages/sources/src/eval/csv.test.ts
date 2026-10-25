import { describe, expect, it } from 'vitest'
import { csvGroup, csvGroupId, parseExportifyCsv, poolTrackOfRow, splitArtists } from './csv'

const EXPORTIFY = [
  '﻿"Track URI","Track Name","Artist URI(s)","Artist Name(s)","Album Name","Album Release Date","Track Duration (ms)","Explicit","Popularity","ISRC","Record Label"',
  '"spotify:track:70LcF31zb1H0PyJoS1Sx1r","Creep","spotify:artist:4Z8W4fKeB5YxbusRsdQVPb","Radiohead","Pablo Honey","1993-02-22","238640","false","87","GBAYE9200070","XL Recordings"',
  '"spotify:track:7KXjTSCq5nL1LoYtL7XAwS","EARFQUAKE","x","Tyler, The Creator,Playboi Carti","IGOR","2019-05-17","190066","true","80","USQX91900628",""',
  '"","No URI","x","Somebody","","2001","not a number","","","bad isrc",""',
  '"spotify:track:1111111111111111111111","","x","Nobody","","","","","","",""',
].join('\r\n')

describe('parseExportifyCsv', () => {
  const rows = parseExportifyCsv(EXPORTIFY)

  it('reads every field Exportify exports', () => {
    expect(rows[0]).toEqual({
      row: 1,
      spotifyId: '70LcF31zb1H0PyJoS1Sx1r',
      popularity: 87,
      source: {
        title: 'Creep',
        artists: [{ name: 'Radiohead' }],
        album: { name: 'Pablo Honey' },
        durationMs: 238640,
        isrc: 'GBAYE9200070',
        isrcOrigin: 'catalog',
        explicit: false,
        releaseDate: '1993-02-22',
        label: 'XL Recordings',
      },
    })
  })

  it('keeps a comma and a space inside a name, as in Tyler, The Creator', () => {
    expect(rows[1]?.source.artists).toEqual([
      { name: 'Tyler, The Creator' },
      { name: 'Playboi Carti' },
    ])
    expect(rows[1]?.source.explicit).toBe(true)
    expect(rows[1]?.source).not.toHaveProperty('label')
    expect(splitArtists('A,B, C')).toEqual(['A', 'B, C'])
  })

  it('leaves out cells that do not parse, and skips rows without a title or artist', () => {
    expect(rows[2]).toEqual({
      row: 3,
      source: { title: 'No URI', artists: [{ name: 'Somebody' }], releaseDate: '2001' },
    })
    expect(rows).toHaveLength(3)
  })

  it('reads the older column names too', () => {
    const older = [
      'Spotify ID,Artist IDs,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity',
      '70LcF31zb1H0PyJoS1Sx1r,x,Creep,Pablo Honey,Radiohead,1993,238640,87',
    ].join('\n')
    expect(parseExportifyCsv(older)[0]).toMatchObject({
      spotifyId: '70LcF31zb1H0PyJoS1Sx1r',
      source: { title: 'Creep', durationMs: 238640, releaseDate: '1993' },
    })
    expect(parseExportifyCsv('')).toEqual([])
  })
})

describe('csvGroup', () => {
  const [creep, , noUri] = parseExportifyCsv(EXPORTIFY)

  it('makes a group with the csv input, its split and its categories', () => {
    if (creep === undefined) throw new Error('no row')
    const group = csvGroup(creep, 'liked.csv', '2026-10-26')
    expect(group).toMatchObject({
      id: 'csv:70LcF31zb1H0PyJoS1Sx1r',
      categories: ['mainstream'],
      provenance: ['liked.csv row 1, read 2026-10-26'],
      spotify: { id: '70LcF31zb1H0PyJoS1Sx1r', popularity: 87 },
      variants: [{ slice: 'csv', source: creep.source }],
    })
    expect(['held-out', 'calibration']).toContain(group.split)
    expect(poolTrackOfRow(creep)).toMatchObject({ id: '70LcF31zb1H0PyJoS1Sx1r', title: 'Creep' })
  })

  it('names a row without a URI by its number', () => {
    if (noUri === undefined) throw new Error('no row')
    expect(csvGroupId(noUri)).toBe('csv:row-3')
    expect(csvGroup(noUri, 'x.csv', '2026-10-26')).not.toHaveProperty('spotify')
    expect(poolTrackOfRow(noUri)).toBeUndefined()
  })
})
