import { YOUTUBE_IMPORT_UNAVAILABLE } from '@fxm/sources/import'
import { catalogScenario, fakeYouTube, song } from '@fxm/sources/import/testing'
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLibrary } from '../../db/repo'
import { asBrowser, USER_AGENTS } from '../connect/testing'
import { useSettingsStore } from '../settings/settings-store'
import { resetImportRunner } from './runner'
import { fakeServices, renderWithServices } from './testing'

afterEach(() => resetImportRunner())

/** A data download's playlists file with these playlists, each of one made-up song. */
function playlistsJson(names: readonly string[]): string {
  return JSON.stringify({
    playlists: names.map((name, index) => ({
      name,
      items: [
        {
          track: {
            trackName: `Song ${index + 1}`,
            artistName: 'Band',
            albumName: 'Album',
            trackUri: `spotify:track:${String(index + 1).padStart(22, '0')}`,
          },
        },
      ],
    })),
  })
}

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
    await user.click(within(list).getByRole('button', { name: 'More options for Road trip' }))
    expect(screen.getByRole('menuitem', { name: 'Open playlist' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    // The source picker is back for the next import, on the tab it was on.
    expect(screen.getByRole('heading', { name: 'What to import' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Playlist file' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
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

  it('shows a listening history being recorded as such, with nothing to resume or cancel', async () => {
    const repo = getLibrary()
    const record = repo.recordPlays.bind(repo)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(repo, 'recordPlays').mockImplementation(async (plays) => {
      await held
      return record(plays)
    })
    const { user } = renderWithServices('/import', fakeServices())
    await screen.findByRole('heading', { level: 1, name: 'Import music' })
    const history = [
      {
        ts: '2021-06-01T12:04:00Z',
        ms_played: 240_000,
        master_metadata_track_name: 'Creep',
        master_metadata_album_artist_name: 'Radiohead',
        spotify_track_uri: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r',
        reason_end: 'trackdone',
      },
    ]
    await user.upload(screen.getByLabelText('Choose ZIP or JSON files'), [
      file('Streaming_History_Audio_2021_0.json', JSON.stringify(history), 'application/json'),
    ])
    await user.click(await screen.findByRole('button', { name: 'Start import' }))
    const list = await screen.findByRole('region', { name: 'Your imports' })
    const card = (await within(list).findByText('Recording plays: 0 of 1')).closest(
      'li',
    ) as HTMLElement
    expect(within(card).queryByRole('button')).toBeNull()
    release()
    expect(await within(card).findByText('1 play recorded')).toBeInTheDocument()
    await user.click(
      within(card).getByRole('button', {
        name: 'More options for Listening history from Spotify',
      }),
    )
    expect(screen.getByRole('menuitem', { name: 'Remove from list' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Cancel/u })).toBeNull()
  })

  it('chooses all playlists or none in one go, and counts the songs it will import', async () => {
    const { user } = renderWithServices('/import', fakeServices())
    await screen.findByRole('heading', { level: 1, name: 'Import music' })
    await user.upload(screen.getByLabelText('Choose ZIP or JSON files'), [
      file('Playlist1.json', playlistsJson(['Morning', 'Noon', 'Night']), 'application/json'),
    ])
    const all = await screen.findByRole('checkbox', { name: 'All playlists (3)' })
    expect(all).toBeChecked()
    expect(screen.getByText('3 songs in 3 playlists')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: /Noon/u }))
    expect((all as HTMLInputElement).indeterminate).toBe(true)
    expect(screen.getByText('2 songs in 2 playlists')).toBeInTheDocument()
    await user.click(all)
    expect(screen.getByText('3 songs in 3 playlists')).toBeInTheDocument()
    await user.click(all)
    expect(all).not.toBeChecked()
    expect(screen.getByText('No playlist chosen')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled()
  })

  it('moves focus to the preview, back to the tab on Cancel, and to the new import on Start', async () => {
    const items = [song('aaaaaaaaaaa', 'First', 'Band'), song('bbbbbbbbbbb', 'Second', 'Band')]
    const services = fakeServices({
      youtube: fakeYouTube({
        playlists: { 'ytm:playlist:PLtestlist01': { name: 'Tube mix', tracks: items } },
        catalog: items,
      }),
    })
    const { user } = renderWithServices('/import', services)
    await screen.findByRole('heading', { level: 1, name: 'Import music' })
    await user.click(screen.getByRole('tab', { name: 'Link' }))
    const link = 'https://music.youtube.com/playlist?list=PLtestlist01'
    await user.type(screen.getByRole('textbox', { name: 'Playlist, album or song link' }), link)
    await user.click(screen.getByRole('button', { name: 'Load' }))
    const heading = await screen.findByRole('heading', { name: 'Ready to import' })
    await waitFor(() => expect(heading).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    const tab = await screen.findByRole('tab', { name: 'Link' })
    await waitFor(() => expect(tab).toHaveFocus())
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Playlist, album or song link' })).toHaveValue(link)

    await user.click(screen.getByRole('button', { name: 'Load' }))
    await user.click(await screen.findByRole('button', { name: 'Start import' }))
    const title = await screen.findByRole('heading', { level: 3, name: 'Tube mix' })
    await waitFor(() => expect(title).toHaveFocus())
  })

  it('ties a link’s error to the field', async () => {
    const { user } = renderWithServices('/import', fakeServices())
    await screen.findByRole('heading', { level: 1, name: 'Import music' })
    await user.click(screen.getByRole('tab', { name: 'Link' }))
    const box = screen.getByRole('textbox', { name: 'Playlist, album or song link' })
    await user.type(box, 'https://example.com/nothing')
    await user.click(screen.getByRole('button', { name: 'Load' }))
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(box).toHaveAccessibleDescription(expect.stringMatching(/isn’t a link FXM can import/u))
  })

  it('explains once that this browser needs FXM Connect, and pauses imports quietly', async () => {
    asBrowser(USER_AGENTS.chromeWindows)
    const services = fakeServices({
      youtube: YOUTUBE_IMPORT_UNAVAILABLE,
      capabilities: () => ({
        youtube: 'none',
        spotify: 'unreachable',
        mediaBytes: false,
        fileSystem: false,
      }),
    })
    const { user } = renderWithServices('/import', services)
    await screen.findByRole('heading', { level: 1, name: 'Import music' })
    await user.click(screen.getByRole('tab', { name: 'Playlist file' }))
    await user.upload(
      screen.getByLabelText('Choose a CSV or M3U file'),
      file('kitchen.csv', 'Title,Artist\nOne,Band\nTwo,Band', 'text/csv'),
    )
    const notice = await screen.findByRole('complementary', { name: 'Finding songs' })
    // The app's own onboarding, and no app that isn't out yet.
    expect(within(notice).getByRole('link', { name: 'add FXM Connect' })).toHaveAttribute(
      'href',
      '/connect',
    )
    expect(notice).toHaveTextContent(
      'The desktop and Android apps, which need no extension, are coming soon.',
    )
    expect(within(notice).queryByRole('link', { name: /desktop|Android/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Start import' }))
    const list = await screen.findByRole('region', { name: 'Your imports' })
    expect(await within(list).findByText('Paused: needs FXM Connect')).toHaveClass(
      'text-text-muted',
    )
    expect(within(list).getByRole('complementary', { name: 'Finding songs' })).toBeInTheDocument()
    expect(
      within(list).getByRole('button', { name: 'Resume importing kitchen' }),
    ).toBeInTheDocument()
  })

  it("doesn't ask for FXM Connect where it can't be added, such as on an iPhone", async () => {
    asBrowser(USER_AGENTS.iphone)
    const services = fakeServices({
      youtube: YOUTUBE_IMPORT_UNAVAILABLE,
      capabilities: () => ({
        youtube: 'none',
        spotify: 'unreachable',
        mediaBytes: false,
        fileSystem: false,
      }),
    })
    const { user } = renderWithServices('/import', services)
    await screen.findByRole('heading', { level: 1, name: 'Import music' })
    await user.click(screen.getByRole('tab', { name: 'Playlist file' }))
    await user.upload(
      screen.getByLabelText('Choose a CSV or M3U file'),
      file('kitchen.csv', 'Title,Artist\nOne,Band', 'text/csv'),
    )
    const notice = await screen.findByRole('complementary', { name: 'Finding songs' })
    expect(notice).toHaveTextContent(
      "YouTube Music needs FXM Connect, which isn't available on iPhone and iPad.",
    )
    expect(within(notice).queryByRole('link', { name: 'add FXM Connect' })).toBeNull()
  })
})
