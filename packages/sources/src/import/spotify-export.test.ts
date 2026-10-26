import { describe, expect, it } from 'vitest'
import { isImportInputError } from './errors'
import {
  exportFileKind,
  LIKED_SONGS_NAME,
  parseEndTime,
  parseSpotifyExport,
} from './spotify-export'

// Constructed samples in the shapes of Spotify's export (see CLEAN-ROOM.md); no real export,
// user name or IP address is in this repository.

const PLAYLISTS = {
  playlists: [
    {
      name: 'Road trip',
      lastModifiedDate: '2024-03-01',
      description: 'For the car',
      numberOfFollowers: 0,
      items: [
        {
          track: {
            trackName: 'Creep',
            artistName: 'Radiohead',
            albumName: 'Pablo Honey',
            trackUri: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
          },
          episode: null,
          localTrack: null,
          audiobook: null,
          addedDate: '2024-02-01',
        },
        {
          track: null,
          episode: { episodeName: 'Ep', showName: 'Show', episodeUri: 'spotify:episode:x' },
          localTrack: null,
          audiobook: null,
          addedDate: '2024-02-02',
        },
        {
          track: null,
          episode: null,
          localTrack: { uri: 'spotify:local:A:B:C:120' },
          audiobook: null,
          addedDate: '2024-02-03',
        },
        {
          track: {
            trackName: 'Karma Police',
            artistName: 'Radiohead',
            albumName: 'OK Computer',
            trackUri: 'spotify:track:0000000000000000000002',
          },
          addedDate: '2024-02-04',
        },
        {
          track: {
            trackName: 'Creep',
            artistName: 'Radiohead',
            albumName: 'Pablo Honey',
            trackUri: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
          },
          addedDate: '2024-02-05',
        },
      ],
    },
    { name: 'Empty one', lastModifiedDate: '2024-03-01', items: [] },
  ],
}

const LIBRARY = {
  tracks: [
    {
      artist: 'Massive Attack',
      album: 'Mezzanine',
      track: 'Angel',
      uri: 'spotify:track:0000000000000000000003',
    },
    { artist: 'Nobody', album: 'Nothing', track: '', uri: 'spotify:track:0000000000000000000004' },
  ],
  albums: [{ artist: 'Portishead', album: 'Dummy', uri: 'spotify:album:0000000000000000000005' }],
  shows: [{ name: 'A show', publisher: 'P', uri: 'spotify:show:x' }],
  episodes: [],
  bannedTracks: [],
  artists: [
    { name: 'Björk', uri: 'spotify:artist:0000000000000000000006' },
    { name: 'Björk', uri: 'spotify:artist:0000000000000000000006' },
  ],
  bannedArtists: [],
  other: [],
}

const HISTORY = [
  { endTime: '2024-03-02 10:04', artistName: 'Radiohead', trackName: 'Creep', msPlayed: 238_000 },
  {
    endTime: '2024-03-02 10:05',
    artistName: 'Radiohead',
    trackName: 'Karma Police',
    msPlayed: 1_200,
  },
  {
    endTime: '2024-03-02 10:10',
    artistName: 'Unknown Band',
    trackName: 'Mystery',
    msPlayed: 200_000,
  },
  {
    endTime: '2024-03-01 09:00',
    artistName: 'Massive Attack',
    trackName: 'Angel',
    msPlayed: 60_000,
  },
]

const EXTENDED = [
  {
    ts: '2021-06-01T12:04:00Z',
    username: 'should-never-be-read',
    platform: 'Android',
    ms_played: 240_000,
    conn_country: 'IN',
    ip_addr_decrypted: '203.0.113.7',
    master_metadata_track_name: 'Creep',
    master_metadata_album_artist_name: 'Radiohead',
    master_metadata_album_album_name: 'Pablo Honey',
    spotify_track_uri: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
    episode_name: null,
    spotify_episode_uri: null,
    reason_start: 'clickrow',
    reason_end: 'trackdone',
    shuffle: false,
    skipped: null,
    offline: false,
  },
  {
    ts: '2021-06-01T12:05:00Z',
    ms_played: 2_000,
    master_metadata_track_name: 'Karma Police',
    master_metadata_album_artist_name: 'Radiohead',
    master_metadata_album_album_name: 'OK Computer',
    spotify_track_uri: 'spotify:track:0000000000000000000002',
    reason_end: 'fwdbtn',
    skipped: true,
  },
  {
    ts: '2021-06-01T12:06:00Z',
    ms_played: 1_000,
    master_metadata_track_name: 'Angel',
    master_metadata_album_artist_name: 'Massive Attack',
    spotify_track_uri: 'spotify:track:0000000000000000000003',
    reason_end: 'endplay',
    skipped: false,
  },
  {
    ts: '2021-06-01T13:00:00Z',
    ms_played: 1_800_000,
    master_metadata_track_name: null,
    spotify_track_uri: null,
    episode_name: 'An episode',
    spotify_episode_uri: 'spotify:episode:0000000000000000000009',
  },
]

const file = (name: string, data: unknown) => ({ name, text: JSON.stringify(data) })

describe('exportFileKind', () => {
  it('knows the export’s files by name, in any folder', () => {
    expect(exportFileKind('Spotify Account Data/Playlist1.json')).toBe('playlists')
    expect(exportFileKind('MyData/Playlist12 (1).json')).toBe('playlists')
    expect(exportFileKind('YourLibrary.json')).toBe('library')
    expect(exportFileKind('StreamingHistory_music_0.json')).toBe('history')
    expect(exportFileKind('StreamingHistory0.json')).toBe('history')
    expect(exportFileKind('Streaming_History_Audio_2019-2021_0.json')).toBe('extended-history')
    expect(exportFileKind('endsong_3.json')).toBe('extended-history')
    expect(exportFileKind('StreamingHistory_podcast_0.json')).toBe('other')
    expect(exportFileKind('Streaming_History_Video_2023.json')).toBe('other')
    expect(exportFileKind('Userdata.json')).toBe('other')
    expect(exportFileKind('Inferences.json')).toBe('other')
  })
})

describe('parseEndTime', () => {
  it('reads "YYYY-MM-DD HH:mm" as UTC', () => {
    expect(parseEndTime('2024-03-02 10:04')).toBe(Date.UTC(2024, 2, 2, 10, 4))
    expect(parseEndTime('nonsense')).toBeUndefined()
    expect(parseEndTime(42)).toBeUndefined()
  })
})

describe('parseSpotifyExport', () => {
  it('reads playlists, liked songs, saved albums and followed artists', () => {
    const parsed = parseSpotifyExport([
      file('Spotify Account Data/Playlist1.json', PLAYLISTS),
      file('Spotify Account Data/YourLibrary.json', LIBRARY),
      file('Spotify Account Data/Userdata.json', { username: 'never-read' }),
    ])
    expect(parsed.kind).toBe('spotify-export')
    expect(parsed.collections.map((collection) => collection.name)).toEqual([
      'Road trip',
      LIKED_SONGS_NAME,
    ])
    const [road, liked] = parsed.collections
    expect(road?.description).toBe('For the car')
    expect(road?.rows).toEqual([
      {
        title: 'Creep',
        artists: ['Radiohead'],
        album: 'Pablo Honey',
        trackId: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
        addedAt: Date.parse('2024-02-01'),
      },
      {
        title: 'Karma Police',
        artists: ['Radiohead'],
        album: 'OK Computer',
        trackId: 'spotify:track:0000000000000000000002',
        addedAt: Date.parse('2024-02-04'),
      },
    ])
    expect(liked?.rows.map((row) => row.title)).toEqual(['Angel'])
    expect(parsed.follows).toEqual([
      {
        id: 'spotify:album:0000000000000000000005',
        source: 'spotify',
        name: 'Dummy',
        artists: [{ name: 'Portishead' }],
        artwork: [],
      },
      {
        id: 'spotify:artist:0000000000000000000006',
        source: 'spotify',
        name: 'Björk',
        artwork: [],
      },
    ])
    expect(parsed.plays).toEqual([])
    expect(parsed.skipped).toMatchObject({
      episodes: 2,
      localFiles: 1,
      duplicates: 1,
      unreadable: 1,
    })
    expect(JSON.stringify(parsed)).not.toContain('never-read')
  })

  it('turns the account data’s history into plays, identified through the export’s own tracks', () => {
    const parsed = parseSpotifyExport([
      file('Playlist1.json', PLAYLISTS),
      file('YourLibrary.json', LIBRARY),
      file('StreamingHistory_music_0.json', HISTORY),
    ])
    expect(parsed.plays.map((play) => [play.track.id, play.playedAt, play.playedMs])).toEqual([
      ['spotify:track:0000000000000000000003', Date.UTC(2024, 2, 1, 9) - 60_000, 60_000],
      ['spotify:track:70LcF31zb1H0PyJoS1Sx1r', Date.UTC(2024, 2, 2, 10, 4) - 238_000, 238_000],
    ])
    expect(parsed.plays[1]?.track).toMatchObject({
      source: 'spotify',
      title: 'Creep',
      artists: [{ name: 'Radiohead' }],
      kind: 'song',
      externalIds: { spotify: '70LcF31zb1H0PyJoS1Sx1r' },
    })
    expect(parsed.plays.every((play) => !play.completed && !play.skipped)).toBe(true)
    // The play of a track a playlist names shares the playlist row's album.
    expect(parsed.plays[1]?.track.album).toEqual({ name: 'Pablo Honey' })
    expect(parsed.skipped).toMatchObject({ shortPlays: 1, unknownPlays: 1 })
  })

  it('prefers the extended history, with completions and skips, and reads nothing personal', () => {
    const parsed = parseSpotifyExport([
      file('StreamingHistory_music_0.json', HISTORY),
      file('Playlist1.json', PLAYLISTS),
      file('Spotify Extended Streaming History/Streaming_History_Audio_2021_0.json', EXTENDED),
    ])
    expect(
      parsed.plays.map((play) => ({
        id: play.track.id,
        at: play.playedAt,
        completed: play.completed,
        skipped: play.skipped,
      })),
    ).toEqual([
      {
        id: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
        at: Date.parse('2021-06-01T12:04:00Z') - 240_000,
        completed: true,
        skipped: false,
      },
      {
        id: 'spotify:track:0000000000000000000002',
        at: Date.parse('2021-06-01T12:05:00Z') - 2_000,
        completed: false,
        skipped: true,
      },
    ])
    expect(parsed.plays[0]?.track.album).toEqual({ name: 'Pablo Honey' })
    // One episode in the playlist, one in the history.
    expect(parsed.skipped).toMatchObject({ shortPlays: 1, episodes: 2 })
    const text = JSON.stringify(parsed)
    for (const secret of ['should-never-be-read', '203.0.113.7', 'Android', 'IN"']) {
      expect(text).not.toContain(secret)
    }
  })

  it('counts files it cannot parse and refuses what is no data export', () => {
    const parsed = parseSpotifyExport([
      { name: 'Playlist1.json', text: '{ not json' },
      file('YourLibrary.json', LIBRARY),
    ])
    expect(parsed.skipped.unreadable).toBe(2)
    const codeOf = (files: { name: string; text: string }[]) => {
      try {
        parseSpotifyExport(files)
        return 'parsed'
      } catch (error) {
        return isImportInputError(error) ? error.code : 'other'
      }
    }
    expect(codeOf([file('Userdata.json', {}), file('notes.txt', {})])).toBe('not-spotify-export')
    expect(codeOf([file('Playlist1.json', { playlists: [] })])).toBe('no-tracks')
    // The account data's history alone names no track: it needs the files that do.
    expect(codeOf([file('StreamingHistory_music_0.json', HISTORY)])).toBe('history-unidentified')
    expect(codeOf([{ name: 'Playlist1.json', text: 'x'.repeat(129 * 1024 * 1024) }])).toBe(
      'too-large',
    )
  })
})
