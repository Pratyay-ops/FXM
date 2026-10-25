import { FakeEngine } from '@fxm/player/testing'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getLibrary } from '../../db/repo'
import { renderApp } from '../../test/render'
import { resetLocalFiles } from './local-files'
import { configureLocalPlayer, getLocalPlayer, resetLocalPlayer } from './player'
import {
  asHandle,
  audioFile,
  type FakeDirectoryHandle,
  fakeFolder,
  flacFile,
  inFolder,
  installTestLocalFiles,
  mp3File,
  pngImage,
} from './testing'

let engine: FakeEngine

beforeEach(() => {
  engine = new FakeEngine()
  configureLocalPlayer({ engine, mediaSession: false })
})

afterEach(async () => {
  resetLocalPlayer()
  await resetLocalFiles()
})

function musicFolder(): FakeDirectoryHandle {
  const cover = { data: pngImage([10, 120, 200]), mime: 'image/png' }
  return fakeFolder('Music', {
    'Aria Vale/Neon Rivers/01 Night Drive.flac': audioFile(
      flacFile({
        tags: { title: 'Night Drive', artists: ['Aria Vale'], album: 'Neon Rivers', track: 1 },
        picture: cover,
      }),
      '01 Night Drive.flac',
    ),
    'Aria Vale/Neon Rivers/02 Slow Tide.mp3': audioFile(
      mp3File({
        tags: { title: 'Slow Tide', artists: ['Aria Vale'], album: 'Neon Rivers', track: 2 },
      }),
      '02 Slow Tide.mp3',
    ),
    'Low Orbit/Afterglow.flac': audioFile(
      flacFile({ tags: { title: 'Afterglow', artists: ['Low Orbit'], album: 'Signals' } }),
      'Afterglow.flac',
    ),
  })
}

/** Local files with `folder` added and scanned, as the app's. */
async function withFolder(folder = musicFolder()) {
  const setup = await installTestLocalFiles({ pickDirectory: async () => asHandle(folder) })
  const result = await setup.files.addFolder()
  if (result.status !== 'added') throw new Error(result.status)
  await setup.files.whenScanned(result.root.id)
  return { ...setup, root: result.root, folder }
}

function songList() {
  return screen.findByRole('list', { name: 'Songs in local files' })
}

async function songTitles() {
  const list = await songList()
  return within(list)
    .getAllByRole('button', { name: /^More options for / })
    .map((button) => button.getAttribute('aria-label')?.replace('More options for ', ''))
}

describe('the Local files tab', () => {
  it('is a tab of the Library', async () => {
    await installTestLocalFiles()
    const { user } = renderApp('/library')
    await user.click(await screen.findByRole('tab', { name: 'Local files' }))
    expect(
      await screen.findByRole('heading', { name: 'Play music files from this device' }),
    ).toBeVisible()
  })

  it('adds a folder the browser keeps access to, and lists its songs', async () => {
    const folder = musicFolder()
    const { files } = await installTestLocalFiles({ pickDirectory: async () => asHandle(folder) })
    const { user } = renderApp('/library?tab=local')
    await user.click(await screen.findByRole('button', { name: 'Add a folder' }))
    const [root] = await files.repo.listRoots()
    await files.whenScanned(root?.id ?? '')
    expect(await songTitles()).toEqual(['Night Drive', 'Slow Tide', 'Afterglow'])
    const sources = screen.getByRole('region', { name: 'Where your music comes from' })
    expect(within(sources).getByText('Music')).toBeVisible()
    expect(within(sources).getByText(/^3 songs · updated/)).toBeVisible()
  })

  it('marks lossless files, and only them', async () => {
    await withFolder()
    renderApp('/library?tab=local')
    const list = await songList()
    const rows = within(list).getAllByRole('listitem')
    const lossless = rows.map((row) => within(row).queryByText('Lossless') !== null)
    expect(lossless).toEqual([true, false, true])
    expect(within(rows[0] as HTMLElement).getByText('FLAC · 16-bit · 44.1 kHz')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('MP3 · 128 kbps')).toBeInTheDocument()
  })

  it('plays a song through the player, from its object URL, and pauses it', async () => {
    await withFolder()
    const { user } = renderApp('/library?tab=local')
    await user.click(await screen.findByRole('button', { name: 'Play Slow Tide' }))
    await waitFor(() => expect(engine.source?.stream.url).toMatch(/^blob:/))
    expect(engine.source?.item?.track.title).toBe('Slow Tide')
    const state = getLocalPlayer().getState()
    expect(state.queue.items.map((item) => item.track.title)).toEqual([
      'Night Drive',
      'Slow Tide',
      'Afterglow',
    ])
    expect(state.queue.context).toEqual({
      type: 'library',
      id: 'local-files',
      title: 'Local files',
    })
    await user.click(await screen.findByRole('button', { name: 'Pause Slow Tide' }))
    expect(getLocalPlayer().getState().status).toBe('paused')
  })

  it('plays and shuffles everything shown', async () => {
    await withFolder()
    const { user } = renderApp('/library?tab=local')
    await songList()
    const main = screen.getByRole('main')
    await user.click(within(main).getByRole('button', { name: 'Shuffle' }))
    await waitFor(() => expect(getLocalPlayer().getState().queue.shuffle).toBe(true))
    await user.click(within(main).getByRole('button', { name: 'Play' }))
    await waitFor(() => expect(getLocalPlayer().getState().queue.shuffle).toBe(false))
    expect(getLocalPlayer().getState().queue.items).toHaveLength(3)
  })

  it('marks formats this browser can’t play and keeps them out of the queue', async () => {
    engine.canPlayStream = (stream) => (stream.codec === 'flac' ? 'no' : 'probably')
    await withFolder()
    const { user } = renderApp('/library?tab=local')
    const list = await songList()
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((row) => within(row).queryByText('Can’t play here') !== null)).toEqual([
      true,
      false,
      true,
    ])
    await user.click(within(list).getByRole('button', { name: 'Play Night Drive' }))
    expect(await screen.findByText('This browser can’t play FLAC files')).toBeVisible()
    expect(getLocalPlayer().getState().queue.items).toEqual([])
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Play' }))
    await waitFor(() =>
      expect(
        getLocalPlayer()
          .getState()
          .queue.items.map((item) => item.track.title),
      ).toEqual(['Slow Tide']),
    )
  })

  it('filters and sorts the songs', async () => {
    await withFolder()
    const { user } = renderApp('/library?tab=local')
    await user.type(await screen.findByLabelText('Filter local files'), 'tide')
    await waitFor(async () => expect(await songTitles()).toEqual(['Slow Tide']))
    await user.clear(screen.getByLabelText('Filter local files'))
    await user.type(screen.getByLabelText('Filter local files'), 'nothing like it')
    expect(await screen.findByText('No songs match “nothing like it”')).toBeVisible()
    await user.clear(screen.getByLabelText('Filter local files'))
    await user.click(screen.getByRole('button', { name: 'Sort: Artist' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Title' }))
    await waitFor(async () =>
      expect(await songTitles()).toEqual(['Afterglow', 'Night Drive', 'Slow Tide']),
    )
    await user.click(screen.getByRole('button', { name: 'Sort: Title' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Recently added' }))
    await waitFor(async () => expect((await songTitles())[0]).toBe('Afterglow'))
  })

  it('likes a song into the library', async () => {
    await withFolder()
    const { user } = renderApp('/library?tab=local')
    await user.click(await screen.findByRole('button', { name: 'Like Afterglow' }))
    await waitFor(async () => {
      const [file] = await getLibrary().db.likes.toArray()
      expect(file?.trackId).toMatch(/^local:track:/)
    })
    expect(
      await screen.findByRole('button', { name: 'Like Afterglow', pressed: true }),
    ).toBeVisible()
  })

  it('queues a song from its menu', async () => {
    await withFolder()
    const { user } = renderApp('/library?tab=local')
    await user.click(await screen.findByRole('button', { name: 'More options for Afterglow' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add to queue' }))
    expect(
      getLocalPlayer()
        .getState()
        .queue.items.map((item) => item.track.title),
    ).toEqual(['Afterglow'])
    expect(await screen.findByText('Added Afterglow to the queue')).toBeVisible()
  })

  it('asks for access again when the browser wants to', async () => {
    const { folder } = await withFolder()
    folder.permission = 'prompt'
    folder.put(
      'More/New Song.flac',
      audioFile(flacFile({ tags: { title: 'New Song' } }), 'New Song.flac'),
    )
    const { user } = renderApp('/library?tab=local')
    expect(
      await screen.findByText('FXM needs your permission to read this folder again'),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Allow access' }))
    expect(folder.requests).toBe(1)
    await waitFor(async () => expect(await songTitles()).toContain('New Song'))
  })

  it('removes a folder after asking', async () => {
    await withFolder()
    const { user } = renderApp('/library?tab=local')
    await user.click(await screen.findByRole('button', { name: 'More options for Music' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove from FXM' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove “Music”?' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(
      await screen.findByRole('heading', { name: 'Play music files from this device' }),
    ).toBeVisible()
  })

  it('uses file inputs where the browser can’t keep folders', async () => {
    const { files } = await installTestLocalFiles({ canKeepFolders: () => false })
    renderApp('/library?tab=local')
    expect(await screen.findByRole('button', { name: 'Choose a folder' })).toBeVisible()
    const input = screen.getAllByTestId('local-folder-input')[0] as HTMLInputElement
    const picked = [
      inFolder(audioFile(flacFile({ tags: { title: 'Night Drive' } }), 'a.flac'), 'Tunes/a.flac'),
      inFolder(audioFile(mp3File({ tags: { title: 'Slow Tide' } }), 'b.mp3'), 'Tunes/b.mp3'),
    ]
    fireEvent.change(input, { target: { files: picked } })
    await waitFor(async () => expect(await files.repo.listRoots()).toHaveLength(1))
    const [root] = await files.repo.listRoots()
    await files.whenScanned(root?.id ?? '')
    expect(await songTitles()).toEqual(['Night Drive', 'Slow Tide'])
    const sources = screen.getByRole('region', { name: 'Where your music comes from' })
    expect(within(sources).getByText('Tunes')).toBeVisible()
    expect(within(sources).getByText('2 songs · until FXM reloads')).toBeVisible()
  })

  it('says when the browser can’t read local files', async () => {
    const { files } = await installTestLocalFiles()
    files.repo.db.close()
    renderApp('/library?tab=local')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'can’t be read in this browser window',
    )
  })
})

describe('local files in search', () => {
  it('shows the songs on this device that match', async () => {
    await withFolder()
    const { user } = renderApp('/search?q=night')
    expect(await screen.findByRole('heading', { name: 'On this device' })).toBeVisible()
    const list = screen.getByRole('list', { name: 'Songs on this device' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    await user.click(within(list).getByRole('button', { name: 'Play Night Drive' }))
    await waitFor(() => expect(engine.source?.item?.track.title).toBe('Night Drive'))
    expect(getLocalPlayer().getState().queue.context).toEqual({
      type: 'search',
      query: 'night',
      title: 'night',
    })
  })

  it('shows nothing when no local file matches', async () => {
    await withFolder()
    renderApp('/search?q=zzz')
    expect(await screen.findByRole('heading', { name: 'Results for “zzz”' })).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('heading', { name: 'On this device' })).toBeNull()
  })
})
