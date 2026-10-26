import { writeFlacTags } from '@fxm/convert'
import { FakeEngine } from '@fxm/player/testing'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLibrary } from '../../db/repo'
import { renderApp } from '../../test/render'
import { appActions } from '../search/actions'
import { appSources } from '../search/sources-context'
import { renderCatalog, resetCatalogState } from '../search/testing'
import { resetLocalFiles } from './local-files'
import { configureLocalPlayer, getLocalPlayer, resetLocalPlayer } from './player'
import { createLocalMetadataProvider } from './provider'
import { type ReadTags, readTags } from './tags'
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
  reloadTestLocalFiles,
  wavFile,
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

/** A promise to wait on, and the function that settles it. */
function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

/** The real tag reader, waiting for `until` first. */
function gatedRead(until: Promise<void>): ReadTags {
  return async (file, name) => {
    await until
    return readTags(file, name)
  }
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
    // Phones fold the folders into one line that opens them.
    const summary = within(sources).getByRole('button', { name: /^Folders: Music · 3 songs/ })
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    // The button that was pressed is gone: focus moves to the folders, and the scan is told.
    expect(screen.getByRole('heading', { name: 'Where your music comes from' })).toHaveFocus()
    expect(await screen.findByText('Added “Music”: 3 songs')).toBeVisible()
  })

  it('adds more music from the Add music menu', async () => {
    const folder = musicFolder()
    const { files } = await withFolder(folder)
    const pick = vi.spyOn(files, 'addFolder')
    const { user } = renderApp('/library?tab=local')
    await user.click(await screen.findByRole('button', { name: 'Add music' }))
    expect(screen.getByRole('menuitem', { name: 'Choose files' })).toBeVisible()
    await user.click(screen.getByRole('menuitem', { name: 'Add a folder' }))
    expect(pick).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByText('“Music” is already in Local files. Looking for changes'),
    ).toBeVisible()
  })

  it('lists a 24-bit, 96 kHz WAV as lossless', async () => {
    await withFolder(
      fakeFolder('Music', {
        'High Tide.wav': audioFile(
          wavFile({
            tags: { title: 'High Tide', artists: ['Aria Vale'] },
            extensible: true,
            bitsPerSample: 24,
            sampleRate: 96_000,
            seconds: 0.1,
          }),
          'High Tide.wav',
        ),
      }),
    )
    renderApp('/library?tab=local')
    const [row] = within(await songList()).getAllByRole('listitem')
    expect(within(row as HTMLElement).getByText('Lossless')).toBeInTheDocument()
    expect(within(row as HTMLElement).getByText('WAV · 24-bit · 96 kHz')).toBeInTheDocument()
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

  it('marks a FLAC that FXM converted from Opus as such, never lossless', async () => {
    // Tagged by Save to device's own writer, as it tags a song saved from YouTube's Opus.
    const converted = writeFlacTags(flacFile(), {
      title: 'Saved Song',
      artists: ['Aria Vale'],
      convertedFrom: { codec: 'opus', bitrateKbps: 160 },
    })
    await withFolder(
      fakeFolder('Music', {
        'Aria Vale - Saved Song.flac': audioFile(converted, 'Aria Vale - Saved Song.flac'),
        'Real.flac': audioFile(
          flacFile({ tags: { title: 'Real', artists: ['Low Orbit'] } }),
          'Real.flac',
        ),
      }),
    )
    renderApp('/library?tab=local')
    const list = await songList()
    const saved = within(list).getByText('Saved Song').closest('li') as HTMLElement
    expect(within(saved).queryByText('Lossless')).toBeNull()
    expect(within(saved).getByText('From Opus')).toBeInTheDocument()
    expect(within(saved).getByText('FLAC · converted from Opus')).toBeInTheDocument()
    const real = within(list).getByText('Real').closest('li') as HTMLElement
    expect(within(real).getByText('Lossless')).toBeInTheDocument()
    expect(within(real).queryByText(/^From /)).toBeNull()
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
    // Paused, the song is still the current one, and not by color alone.
    const resume = await screen.findByRole('button', { name: 'Resume Slow Tide' })
    expect(resume.closest('li')).toHaveAttribute('aria-current', 'true')
    expect(
      within(await songList())
        .getAllByRole('listitem')
        .filter((row) => row.hasAttribute('aria-current')),
    ).toHaveLength(1)
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

  it('keeps the text of songs that can’t play at full contrast', async () => {
    engine.canPlayStream = (stream) => (stream.codec === 'flac' ? 'no' : 'probably')
    await withFolder()
    renderApp('/library?tab=local')
    const [row] = within(await songList()).getAllByRole('listitem')
    const item = row as HTMLElement
    // No fading of the whole row: only the cover fades, and the title turns muted.
    const faded = [item, ...item.querySelectorAll('*')].filter((element) =>
      (element.getAttribute('class') ?? '')
        .split(/\s+/)
        .some((name) => name.startsWith('opacity-')),
    )
    // The cover: an image, or the decorative placeholder.
    expect(faded).toHaveLength(1)
    expect(faded[0]?.matches('img, [aria-hidden="true"]')).toBe(true)
    expect(within(item).getByText('Night Drive')).toHaveClass('truncate')
    expect(within(item).getByText('Night Drive').parentElement).toHaveClass('text-text-muted')
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

  it('keeps the chosen order while filtering', async () => {
    await withFolder()
    const { user } = renderApp('/library?tab=local&sort=title')
    // "i" is in every title: Afterglow, Night Drive, Slow Tide, by title.
    await user.type(await screen.findByLabelText('Filter local files'), 'i')
    await waitFor(async () =>
      expect(await songTitles()).toEqual(['Afterglow', 'Night Drive', 'Slow Tide']),
    )
    await user.click(screen.getByRole('button', { name: 'Sort: Title' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Artist' }))
    await waitFor(async () =>
      expect(await songTitles()).toEqual(['Night Drive', 'Slow Tide', 'Afterglow']),
    )
  })

  it('opens and closes the filter from its button on phones', async () => {
    await withFolder()
    const { user } = renderApp('/library?tab=local')
    const toggle = await screen.findByRole('button', { name: 'Filter songs' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(screen.getByLabelText('Filter local files')).toHaveFocus()
    await user.type(screen.getByLabelText('Filter local files'), 'tide')
    await waitFor(async () => expect(await songTitles()).toEqual(['Slow Tide']))
    await user.click(screen.getByRole('button', { name: 'Close filter' }))
    expect(screen.getByLabelText('Filter local files')).toHaveValue('')
    await waitFor(async () => expect(await songTitles()).toHaveLength(3))
  })

  it('likes a song into the library', async () => {
    await withFolder()
    const { user } = renderApp('/library?tab=local')
    await user.click(await screen.findByRole('button', { name: 'Like Afterglow' }))
    await waitFor(async () => {
      const [file] = (await getLibrary().snapshot()).likes
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
    await user.click(screen.getByRole('button', { name: 'Allow access: Music' }))
    expect(folder.requests).toBe(1)
    await waitFor(async () => expect(await songTitles()).toContain('New Song'))
  })

  it('offers to choose a refused folder again, and to find a missing one', async () => {
    const { folder, deps } = await withFolder()
    folder.permission = 'denied'
    await reloadTestLocalFiles(deps)
    const { user } = renderApp('/library?tab=local')
    expect(await screen.findByText('You didn’t allow FXM to read this folder')).toBeVisible()
    // The browser won't ask again once refused: picking the folder grants access anew.
    folder.permission = 'granted'
    await user.click(screen.getByRole('button', { name: 'Choose folder again: Music' }))
    expect(await screen.findByText('Found “Music”: 3 songs')).toBeVisible()
    expect(screen.queryByText('You didn’t allow FXM to read this folder')).toBeNull()
    folder.listError = new DOMException('gone', 'NotFoundError')
    await user.click(screen.getByRole('button', { name: 'More options for Music' }))
    await user.click(screen.getByRole('menuitem', { name: 'Scan for changes' }))
    expect(await screen.findByText('This folder was moved or deleted')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Find folder: Music' })).toBeVisible()
  })

  it('names each folder’s buttons after it, and stops a scan', async () => {
    const release = gate()
    const folder = musicFolder()
    const { files } = await installTestLocalFiles({
      pickDirectory: async () => asHandle(folder),
      readTags: gatedRead(release.opened),
    })
    const { user } = renderApp('/library?tab=local')
    await user.click(await screen.findByRole('button', { name: 'Add a folder' }))
    const stop = await screen.findByRole('button', { name: 'Stop scanning Music' })
    expect(screen.getByRole('progressbar', { name: 'Scanning Music' })).toBeInTheDocument()
    await user.click(stop)
    release.open()
    const [root] = await files.repo.listRoots()
    await files.whenScanned(root?.id ?? '')
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Stop scanning Music' })).toBeNull(),
    )
  })

  it('keeps songs of chosen files the browser forgot out of the queue, and says why', async () => {
    const { files, deps } = await withFolder()
    await files.addPicked([
      audioFile(flacFile({ tags: { title: 'Zebra Crossing', artists: ['Zed'] } }), 'z.flac'),
    ])
    await files.settled()
    // A reload: the kept folder stays, the chosen file is forgotten.
    await reloadTestLocalFiles(deps)
    const { user } = renderApp('/library?tab=local')
    const list = await songList()
    const zebra = await within(list).findByText('Zebra Crossing')
    const row = zebra.closest('li') as HTMLElement
    expect(await within(row).findByText('Choose again')).toBeVisible()
    await user.click(within(row).getByRole('button', { name: 'Play Zebra Crossing' }))
    expect(await screen.findByText('Choose your files again to play this song')).toBeVisible()
    expect(getLocalPlayer().getState().queue.items).toEqual([])
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Play' }))
    await waitFor(() =>
      expect(
        getLocalPlayer()
          .getState()
          .queue.items.map((item) => item.track.title),
      ).toEqual(['Night Drive', 'Slow Tide', 'Afterglow']),
    )
    await user.click(within(row).getByRole('button', { name: 'More options for Zebra Crossing' }))
    expect(screen.getByRole('menuitem', { name: 'Add to queue' })).toBeDisabled()
  })

  it('offers to choose the files again when nothing else can play', async () => {
    const { files, deps } = await installTestLocalFiles({ canKeepFolders: () => false })
    await files.addPicked([
      inFolder(audioFile(flacFile({ tags: { title: 'Night Drive' } }), 'a.flac'), 'Tunes/a.flac'),
    ])
    await files.settled()
    await reloadTestLocalFiles(deps)
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const { user } = renderApp('/library?tab=local')
    const fix = await screen.findByRole('button', { name: 'Choose “Tunes” again' })
    expect(within(screen.getByRole('main')).queryByRole('button', { name: 'Play' })).toBeNull()
    await user.click(fix)
    expect(click).toHaveBeenCalledTimes(1)
    expect((click.mock.contexts[0] as HTMLInputElement).dataset.testid).toBe('local-folder-input')
    click.mockRestore()
  })

  it('removes a folder after asking, and keeps focus on the page', async () => {
    await withFolder()
    const { user } = renderApp('/library?tab=local')
    await user.click(await screen.findByRole('button', { name: 'More options for Music' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove from FXM' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove “Music”?' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(
      await screen.findByRole('heading', { name: 'Play music files from this device' }),
    ).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a folder' })).toHaveFocus())
  })

  it('offers music files only where the browser can’t choose folders', async () => {
    await installTestLocalFiles({ canKeepFolders: () => false, canChooseFolders: () => false })
    renderApp('/library?tab=local')
    expect(await screen.findByRole('button', { name: 'Choose music files' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /folder/ })).toBeNull()
    const folderInput = screen.getAllByTestId('local-folder-input')[0] as HTMLInputElement
    // Where folders can't be chosen, the folder input takes music files instead.
    expect(folderInput.multiple).toBe(true)
    expect(folderInput.accept).toContain('audio/*')
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
  afterEach(resetCatalogState)

  it('marks songs of chosen files the browser forgot, as the Library does', async () => {
    const { files, deps } = await installTestLocalFiles({ canKeepFolders: () => false })
    await files.addPicked([audioFile(flacFile({ tags: { title: 'Night Drive' } }), 'night.flac')])
    await files.settled()
    await reloadTestLocalFiles(deps)
    const { user } = renderApp('/search?q=night')
    const list = await screen.findByRole('list', { name: 'Songs on this device' })
    expect(screen.getByText('Music files you added to FXM')).toBeVisible()
    expect(await within(list).findByText('Choose again')).toBeVisible()
    await user.click(within(list).getByRole('button', { name: 'Play Night Drive' }))
    expect(await screen.findByText('Choose your files again to play this song')).toBeVisible()
    expect(getLocalPlayer().getState().queue.items).toEqual([])
  })

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

  it('lists the songs once while searching this device itself', async () => {
    await withFolder()
    // As the app's composition root registers it, once there is music on the device, with the
    // catalog's Download entries wired in.
    const unregister = appSources.register(createLocalMetadataProvider())
    const actions = appActions.get()
    appActions.set({ ...actions, downloads: { download: vi.fn() } })
    try {
      const { user } = renderApp('/search?q=night')
      expect(await screen.findByRole('heading', { name: 'On this device' })).toBeVisible()

      await user.click(await screen.findByRole('radio', { name: 'This device' }))

      const songs = await screen.findByRole('list', { name: 'Songs' })
      expect(within(songs).getByText('Night Drive')).toBeVisible()
      expect(screen.queryByRole('heading', { name: 'On this device' })).toBeNull()
      // A file on the device has nothing to download.
      await user.click(within(songs).getByRole('button', { name: 'More options for Night Drive' }))
      const menu = await screen.findByRole('menu')
      expect(within(menu).queryByRole('menuitem', { name: 'Download' })).toBeNull()
    } finally {
      unregister()
      appActions.set(actions)
    }
  })

  it('shows nothing when no local file matches', async () => {
    await withFolder()
    // With a catalog to search, the page shows its results under the query's heading.
    renderCatalog('/search?q=zzz')
    expect(await screen.findByRole('heading', { name: 'Results for “zzz”' })).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('heading', { name: 'On this device' })).toBeNull()
  })
})
