import { catalogScenario, fakeYouTube, song } from '@fxm/sources/import/testing'
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getLibrary } from '../../db/repo'
import { useSettingsStore } from '../settings/settings-store'
import { resetImportRunner } from './runner'
import { fakeServices, renderWithServices } from './testing'

afterEach(() => resetImportRunner())

/** A CSV in Exportify's columns for the scenario's tracks (constructed for the test). */
function exportifyCsv(tracks: ReturnType<typeof catalogScenario>['tracks']): string {
  const header =
    '"Track URI","Track Name","Artist Name(s)","Album Name","Track Duration (ms)","ISRC"'
  const lines = tracks.map((track) =>
    [
      `spotify:track:${track.externalIds?.spotify}`,
      track.title,
      track.artists.map((artist) => artist.name).join(', '),
      track.album?.name ?? '',
      String(track.durationMs ?? ''),
      track.isrc ?? '',
    ]
      .map((value) => `"${value}"`)
      .join(','),
  )
  return [header, ...lines].join('\n')
}

function file(name: string, text: string, type = 'text/plain'): File {
  return new File([text], name, { type })
}

describe('ImportPage', () => {
  it('opens from the library', async () => {
    const { user } = renderWithServices('/library', fakeServices())
    await user.click(await screen.findByRole('link', { name: 'Import' }))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Import music' }),
    ).toBeInTheDocument()
  })

  it('imports a CSV file: preview, start, then the match runs in the background', async () => {
    const scenario = catalogScenario([
      ['isrc', 4],
      ['missing', 1],
    ])
    const services = fakeServices({ youtube: fakeYouTube({ catalog: scenario.catalog }) })
    const { user } = renderWithServices('/import', services)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Import music' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Playlist file' }))
    await user.upload(
      screen.getByLabelText('Choose a CSV or M3U file'),
      file('road_trip.csv', exportifyCsv(scenario.tracks), 'text/csv'),
    )
    expect(await screen.findByRole('heading', { name: 'Ready to import' })).toBeInTheDocument()
    const name = screen.getByRole('textbox', { name: 'Playlist name' })
    expect(name).toHaveValue('road trip')
    await user.clear(name)
    await user.type(name, 'Road trip')
    expect(screen.getByText('5 songs')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start import' }))

    expect(await screen.findByText('Importing 1 playlist')).toBeInTheDocument()
    const list = await screen.findByRole('region', { name: 'Your imports' })
    expect(await within(list).findByText('Done')).toBeInTheDocument()
    expect(within(list).getByText(/5 songs: 4 matched · 1 to review/u)).toBeInTheDocument()
    expect(within(list).getByRole('link', { name: 'Review 1 song of Road trip' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/import\//u),
    )
    expect(
      within(list).getByRole('link', { name: 'Open the playlist Road trip' }),
    ).toBeInTheDocument()
    // The source picker is back for the next import.
    expect(screen.getByRole('heading', { name: 'What to import' })).toBeInTheDocument()
  })

  it('imports Spotify’s data download with its playlists, history and follows', async () => {
    const services = fakeServices({
      youtube: fakeYouTube({
        catalog: [song('creep000001', 'Creep', 'Radiohead', { seconds: 239 })],
      }),
    })
    const { user } = renderWithServices('/import', services)
    await screen.findByRole('heading', { level: 1, name: 'Import music' })
    const playlists = {
      playlists: [
        {
          name: 'Evening',
          items: [
            {
              track: {
                trackName: 'Creep',
                artistName: 'Radiohead',
                albumName: 'Pablo Honey',
                trackUri: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
              },
            },
            { track: null, episode: { episodeName: 'E' } },
          ],
        },
      ],
    }
    const library = {
      tracks: [],
      artists: [{ name: 'Radiohead', uri: 'spotify:artist:4Z8W4fKeB5YxbusRsdQVPb' }],
    }
    const history = [
      {
        endTime: '2024-03-02 10:04',
        artistName: 'Radiohead',
        trackName: 'Creep',
        msPlayed: 238_000,
      },
    ]
    await user.upload(screen.getByLabelText('Choose ZIP or JSON files'), [
      file('Playlist1.json', JSON.stringify(playlists), 'application/json'),
      file('YourLibrary.json', JSON.stringify(library), 'application/json'),
      file('StreamingHistory_music_0.json', JSON.stringify(history), 'application/json'),
    ])
    expect(await screen.findByRole('heading', { name: 'Ready to import' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Playlist name' })).toHaveValue('Evening')
    expect(screen.getByRole('checkbox', { name: /Listening history: 1 play/u })).toBeChecked()
    expect(
      screen.getByRole('checkbox', { name: /Saved albums and followed artists: 1/u }),
    ).toBeChecked()
    expect(screen.getByText('Left out: 1 podcast episode.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start import' }))
    expect(
      await screen.findByText('Importing 1 playlist, 1 play, 1 album or artist'),
    ).toBeInTheDocument()
    const list = await screen.findByRole('region', { name: 'Your imports' })
    expect(await within(list).findByText('1 play recorded')).toBeInTheDocument()
    await waitFor(async () => expect(await getLibrary().history()).toHaveLength(1))
    expect((await getLibrary().listFollows('artist')).map((follow) => follow.name)).toEqual([
      'Radiohead',
    ])
  })

  it('says why a file can’t be imported', async () => {
    const { user } = renderWithServices('/import', fakeServices())
    await screen.findByRole('heading', { level: 1, name: 'Import music' })
    await user.click(screen.getByRole('tab', { name: 'Playlist file' }))
    await user.upload(
      screen.getByLabelText('Choose a CSV or M3U file'),
      file('x.csv', 'Artist,Album\nA,B'),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/no column of song titles/u)
    await user.click(screen.getByRole('tab', { name: 'Spotify data' }))
    await user.upload(screen.getByLabelText('Choose ZIP or JSON files'), [
      file('Userdata.json', '{}'),
    ])
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /aren’t from Spotify’s data download/u,
    )
  })

  it('loads a YouTube playlist link, and refuses links it can’t import', async () => {
    const items = [song('aaaaaaaaaaa', 'First', 'Band'), song('bbbbbbbbbbb', 'Second', 'Band')]
    const services = fakeServices({
      youtube: fakeYouTube({
        playlists: { 'ytm:playlist:PLtestlist01': { name: 'Tube mix', tracks: items } },
        catalog: items,
      }),
    })
    useSettingsStore.setState({ catalogMode: 'all' })
    const { user } = renderWithServices('/import', services)
    await screen.findByRole('heading', { level: 1, name: 'Import music' })
    await user.click(screen.getByRole('tab', { name: 'Link' }))
    const box = screen.getByRole('textbox', { name: 'Playlist, album or song link' })
    await user.type(box, 'https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb')
    await user.click(screen.getByRole('button', { name: 'Load' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/isn’t a link FXM can import/u)

    await user.clear(box)
    await user.type(box, 'https://music.youtube.com/playlist?list=PLtestlist01')
    await user.click(screen.getByRole('button', { name: 'Load' }))
    expect(await screen.findByRole('heading', { name: 'Ready to import' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Playlist name' })).toHaveValue('Tube mix')
    expect(screen.getByText(/for the Music \+ Video mode/u)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start import' }))
    const list = await screen.findByRole('region', { name: 'Your imports' })
    expect(await within(list).findByText('Done')).toBeInTheDocument()
    expect(within(list).getByText(/2 songs: 2 matched/u)).toBeInTheDocument()
  })
})
