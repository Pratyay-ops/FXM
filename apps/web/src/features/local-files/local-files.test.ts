import { isFxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { createLocalFiles } from './local-files'
import { type ReadTags, readTags } from './tags'
import {
  asHandle,
  audioFile,
  domError,
  type FakeDirectoryHandle,
  fakeFolder,
  flacFile,
  inFolder,
  mp3File,
  pngImage,
  testLocalFiles,
} from './testing'

function flac(title: string, lastModified = 1000) {
  return audioFile(flacFile({ tags: { title, artists: ['Aria Vale'] } }), `${title}.flac`, {
    lastModified,
  })
}

function mp3(title: string) {
  return audioFile(mp3File({ tags: { title, artists: ['Aria Vale'] } }), `${title}.mp3`)
}

/** A facade whose folder picker returns `folder`. */
function withFolder(folder: FakeDirectoryHandle) {
  return testLocalFiles({ pickDirectory: async () => asHandle(folder) })
}

async function addAndScan(files: ReturnType<typeof testLocalFiles>['files']) {
  const result = await files.addFolder()
  if (result.status !== 'added') throw new Error(`Not added: ${result.status}`)
  await files.whenScanned(result.root.id)
  return result.root
}

/** A promise to wait on, and the function that settles it. */
function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

/** The real tag reader, counted, waiting for `until` when given. */
function countedRead(until?: Promise<void>) {
  return vi.fn<ReadTags>(async (file, name) => {
    await until
    return readTags(file, name)
  })
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('It did not fail')
}

describe('adding a folder', () => {
  it('keeps the folder and its handle, scans it and says it is ready', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A'), 'b.mp3': mp3('B') })
    const { files, refreshed } = withFolder(folder)
    const root = await addAndScan(files)
    expect(root).toMatchObject({ kind: 'folder', name: 'Music' })
    expect(await files.repo.handles.get(root.id)).toBe(folder)
    const stored = await files.repo.getRoot(root.id)
    expect(stored?.scannedAt).toBeDefined()
    expect(stored?.skipped).toBeUndefined()
    expect(await files.repo.filesOfRoot(root.id)).toHaveLength(2)
    expect(files.statusOf(root.id)).toEqual({ state: 'ready' })
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0]).toHaveLength(2)
  })

  it('does nothing when the picker is closed', async () => {
    const { files } = testLocalFiles()
    expect(await files.addFolder()).toEqual({ status: 'cancelled' })
    expect(await files.repo.listRoots()).toEqual([])
  })

  it('scans a folder added again instead of adding it twice', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A') })
    const { files } = withFolder(folder)
    const root = await addAndScan(files)
    folder.put('b.flac', flac('B'))
    const again = await files.addFolder()
    expect(again).toMatchObject({ status: 'exists', root: { id: root.id } })
    await files.whenScanned(root.id)
    expect(await files.repo.filesOfRoot(root.id)).toHaveLength(2)
    expect(await files.repo.listRoots()).toHaveLength(1)
  })

  it('refuses a folder inside one already added', async () => {
    const music = fakeFolder('Music', { 'Jazz/a.flac': flac('A') })
    let pick = music
    const { files } = testLocalFiles({ pickDirectory: async () => asHandle(pick) })
    const root = await addAndScan(files)
    pick = music.folder('Jazz')
    expect(await files.addFolder()).toMatchObject({ status: 'inside', root: { id: root.id } })
  })

  it('replaces folders inside a new one, keeping their songs’ IDs, unread', async () => {
    const music = fakeFolder('Music', { 'Jazz/a.flac': flac('A'), 'Pop/b.flac': flac('B') })
    let pick = music.folder('Jazz')
    const read = countedRead()
    const { files } = testLocalFiles({ pickDirectory: async () => asHandle(pick), readTags: read })
    const jazz = await addAndScan(files)
    const [song] = await files.repo.filesOfRoot(jazz.id)
    pick = music
    const root = await addAndScan(files)
    expect((await files.repo.listRoots()).map((each) => each.id)).toEqual([root.id])
    const listed = await files.repo.filesOfRoot(root.id)
    expect(listed).toHaveLength(2)
    expect(listed.find((file) => file.path === 'Jazz/a.flac')?.id).toBe(song?.id)
    expect(await files.repo.handles.get(jazz.id)).toBeUndefined()
    // Jazz/a.flac moved over as it was: only Pop/b.flac was read.
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps one list when the first scan of a bigger folder is stopped', async () => {
    const music = fakeFolder('Music', { 'Jazz/a.flac': flac('A'), 'Pop/b.flac': flac('B') })
    let pick = music.folder('Jazz')
    const { files } = testLocalFiles({ pickDirectory: async () => asHandle(pick) })
    const jazz = await addAndScan(files)
    const [song] = await files.repo.filesOfRoot(jazz.id)
    pick = music
    const result = await files.addFolder()
    if (result.status !== 'added') throw new Error(result.status)
    files.cancelScan(result.root.id)
    await files.whenScanned(result.root.id)
    expect((await files.repo.listRoots()).map((each) => each.id)).toEqual([result.root.id])
    const listed = await files.repo.listFiles()
    expect(listed.filter((file) => file.tags.title === 'A')).toEqual([
      expect.objectContaining({ rootId: result.root.id, path: 'Jazz/a.flac', id: song?.id }),
    ])
    // Adding it again finds it, and nothing else.
    expect(await files.addFolder()).toMatchObject({
      status: 'exists',
      root: { id: result.root.id },
    })
  })

  it('takes in folders added inside a folder that is added again', async () => {
    const music = fakeFolder('Music', { 'Jazz/a.flac': flac('A'), 'b.flac': flac('B') })
    const pick = music
    const { files, deps } = testLocalFiles({ pickDirectory: async () => asHandle(pick) })
    const root = await addAndScan(files)
    // A list from before folders took in their subfolders: Jazz beside Music.
    const jazz = { id: 'jazz', kind: 'folder' as const, name: 'Jazz', addedAt: 0 }
    await deps.repo.putRoot(jazz)
    await deps.repo.handles.put(jazz.id, asHandle(music.folder('Jazz')))
    expect(await files.addFolder()).toMatchObject({ status: 'exists', root: { id: root.id } })
    await files.whenScanned(root.id)
    expect((await files.repo.listRoots()).map((each) => each.id)).toEqual([root.id])
  })

  it('keeps what a stopped scan read, and stays ready', async () => {
    const folder = fakeFolder(
      'Music',
      Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `Disc ${index}/song.flac`,
          flac(`Song ${index}`),
        ]),
      ),
    )
    const { files } = withFolder(folder)
    const result = await files.addFolder()
    if (result.status !== 'added') throw new Error(result.status)
    files.cancelScan(result.root.id)
    expect(await files.whenScanned(result.root.id)).toMatchObject({ status: 'cancelled' })
    expect(files.statusOf(result.root.id)).toEqual({ state: 'ready' })
    expect((await files.repo.getRoot(result.root.id))?.scannedAt).toBeUndefined()
  })

  it('doesn’t start a stopped scan again in the same visit unless asked', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A'), 'b.flac': flac('B') })
    const read = countedRead()
    const { files } = testLocalFiles({
      pickDirectory: async () => asHandle(folder),
      readTags: read,
    })
    const result = await files.addFolder()
    if (result.status !== 'added') throw new Error(result.status)
    files.cancelScan(result.root.id)
    await files.whenScanned(result.root.id)
    const reads = read.mock.calls.length
    // The Library tab checks the folders whenever it opens.
    await files.checkRoots()
    expect(await files.whenScanned(result.root.id)).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(reads)
    expect(files.statusOf(result.root.id)).toEqual({ state: 'ready' })
    // Scan for changes still scans.
    await files.rescan(result.root.id)
    expect(await files.repo.filesOfRoot(result.root.id)).toHaveLength(2)
  })

  it('reports what a scan did', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A'), 'b.mp3': mp3('B') })
    const { files } = withFolder(folder)
    const result = await files.addFolder()
    if (result.status !== 'added') throw new Error(result.status)
    expect(await files.whenScanned(result.root.id)).toMatchObject({
      status: 'done',
      added: 2,
      skipped: {},
    })
    expect(await files.repo.countFiles(result.root.id)).toBe(2)
  })

  it('records the files a scan left out', async () => {
    const folder = fakeFolder('Music', {
      'a.flac': flac('A'),
      'b.flac': audioFile(new Uint8Array(80).fill(3), 'b.flac'),
    })
    const { files } = withFolder(folder)
    const root = await addAndScan(files)
    const stored = await files.repo.getRoot(root.id)
    expect(Object.values(stored?.skipped ?? {}).reduce((sum, count) => sum + count, 0)).toBe(1)
  })

  it('says when a folder was moved or deleted', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A') })
    const { files } = withFolder(folder)
    const root = await addAndScan(files)
    folder.listError = new DOMException('gone', 'NotFoundError')
    await files.rescan(root.id)
    expect(files.statusOf(root.id)).toEqual({ state: 'missing' })
  })

  it('finds a folder that moved, keeping its songs’ IDs', async () => {
    const old = fakeFolder('Music', { 'Album/a.flac': flac('A'), 'b.flac': flac('B') })
    let pick = old
    const read = countedRead()
    const { files } = testLocalFiles({ pickDirectory: async () => asHandle(pick), readTags: read })
    const root = await addAndScan(files)
    const before = await files.repo.filesOfRoot(root.id)
    old.listError = domError('NotFoundError')
    await files.rescan(root.id)
    expect(files.statusOf(root.id)).toEqual({ state: 'missing' })
    // On another drive now, under another name.
    pick = fakeFolder('My Music', { 'Album/a.flac': flac('A'), 'b.flac': flac('B') })
    expect(await files.addFolder({ replace: root.id })).toMatchObject({
      status: 'replaced',
      root: { id: root.id, name: 'My Music' },
    })
    await files.whenScanned(root.id)
    expect(files.statusOf(root.id)).toEqual({ state: 'ready' })
    expect(await files.repo.listRoots()).toEqual([
      expect.objectContaining({ id: root.id, name: 'My Music' }),
    ])
    const ids = (files: { path: string; id: string }[]) =>
      files.map(({ path, id }) => `${path}=${id}`).sort()
    expect(ids(await files.repo.filesOfRoot(root.id))).toEqual(ids(before))
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('says a folder whose handle is gone is missing', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A') })
    const { files, deps } = withFolder(folder)
    const root = await addAndScan(files)
    await deps.repo.handles.delete(root.id)
    const visit = createLocalFiles(deps)
    await visit.checkRoots()
    expect(visit.statusOf(root.id)).toEqual({ state: 'missing' })
    const [file] = await visit.repo.filesOfRoot(root.id)
    expect(isFxmError(await errorOf(visit.streamFor(file?.id ?? '')), 'NotFound')).toBe(true)
  })
})

describe('scanning one folder at a time', () => {
  it('lets the next scan wait its turn, and stops one before it starts', async () => {
    const one = fakeFolder('One', { 'a.flac': flac('A') })
    const two = fakeFolder('Two', { 'b.flac': flac('B') })
    let pick = one
    const { files, deps } = testLocalFiles({ pickDirectory: async () => asHandle(pick) })
    const first = await addAndScan(files)
    pick = two
    const second = await addAndScan(files)
    one.put('c.flac', flac('C'))
    two.put('d.flac', flac('D'))
    // A new visit scans both again: the second waits while the first reads.
    const release = gate()
    const visit = createLocalFiles({ ...deps, readTags: countedRead(release.opened) })
    await visit.checkRoots()
    expect(visit.statusOf(first.id)).toMatchObject({ state: 'scanning' })
    expect(visit.statusOf(second.id)).toEqual({ state: 'queued' })
    visit.cancelScan(second.id)
    expect(await visit.whenScanned(second.id)).toBeUndefined()
    expect(visit.statusOf(second.id)).toEqual({ state: 'ready' })
    release.open()
    await visit.settled()
    expect(await visit.repo.countFiles(first.id)).toBe(2)
    expect(await visit.repo.countFiles(second.id)).toBe(1)
  })

  it('gives files of two folders of one name their own IDs', async () => {
    const home = fakeFolder('Music', { 'a.flac': flac('A') })
    const drive = fakeFolder('Music', { 'b.flac': flac('B') })
    let pick = home
    const { files, deps } = testLocalFiles({ pickDirectory: async () => asHandle(pick) })
    await addAndScan(files)
    pick = drive
    await addAndScan(files)
    home.put('new.flac', flac('New A', 2000))
    drive.put('new.flac', flac('New B', 2000))
    const visit = createLocalFiles(deps)
    await visit.checkRoots()
    await visit.settled()
    const added = (await visit.repo.listFiles()).filter((file) => file.path === 'new.flac')
    expect(added.map((file) => file.tags.title).sort()).toEqual(['New A', 'New B'])
    expect(new Set(added.map((file) => file.id)).size).toBe(2)
  })

  it('keeps a cover a running scan stored when another folder goes', async () => {
    const cover = (rgb: [number, number, number]) => ({ data: pngImage(rgb), mime: 'image/png' })
    const withCover = (title: string, rgb: [number, number, number]) =>
      audioFile(flacFile({ tags: { title }, picture: cover(rgb) }), `${title}.flac`)
    const gone = fakeFolder('Gone', { 'g.flac': withCover('G', [9, 9, 9]) })
    const kept = fakeFolder('Kept', { 'k.flac': withCover('K', [1, 2, 3]) })
    let pick = gone
    const { files } = testLocalFiles({ pickDirectory: async () => asHandle(pick) })
    const goneRoot = await addAndScan(files)
    const [goneFile] = await files.repo.filesOfRoot(goneRoot.id)
    // The next scan stores its cover, then waits before writing the record that uses it.
    const reached = gate()
    const release = gate()
    const write = files.repo.applyFiles.bind(files.repo)
    vi.spyOn(files.repo, 'applyFiles').mockImplementation(async (changes) => {
      if ((changes.put?.length ?? 0) > 0) {
        reached.open()
        await release.opened
      }
      return write(changes)
    })
    pick = kept
    const keptRoot = await files.addFolder()
    if (keptRoot.status !== 'added') throw new Error(keptRoot.status)
    await reached.opened
    await files.removeRoot(goneRoot.id)
    release.open()
    await files.settled()
    const [keptFile] = await files.repo.filesOfRoot(keptRoot.root.id)
    expect(await files.repo.hasPicture(keptFile?.pictureKey ?? '')).toBe(true)
    expect(await files.repo.hasPicture(goneFile?.pictureKey ?? '')).toBe(false)
  })
})

describe('access to kept folders', () => {
  it('asks again in a new visit and scans once allowed', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A') })
    const { files, deps } = withFolder(folder)
    const root = await addAndScan(files)
    // A new visit: the same database, a new facade, and the browser wants to ask.
    folder.permission = 'prompt'
    const visit = createLocalFiles(deps)
    await visit.checkRoots()
    expect(visit.statusOf(root.id)).toEqual({ state: 'needs-access' })
    folder.put('b.flac', flac('B'))
    expect(await visit.requestAccess(root.id)).toBe('granted')
    expect(folder.requests).toBe(1)
    await visit.whenScanned(root.id)
    expect(visit.statusOf(root.id)).toEqual({ state: 'ready' })
    expect(await visit.repo.filesOfRoot(root.id)).toHaveLength(2)
  })

  it('scans a readable folder again once per visit', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A') })
    const { files, deps } = withFolder(folder)
    const root = await addAndScan(files)
    folder.put('b.flac', flac('B'))
    const visit = createLocalFiles(deps)
    await visit.checkRoots()
    await visit.whenScanned(root.id)
    expect(await visit.repo.filesOfRoot(root.id)).toHaveLength(2)
    folder.put('c.flac', flac('C'))
    await visit.checkRoots()
    await visit.whenScanned(root.id)
    expect(await visit.repo.filesOfRoot(root.id)).toHaveLength(2)
    expect(visit.statusOf(root.id)).toEqual({ state: 'ready' })
  })

  it('remembers a refusal', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A') })
    const { files, deps } = withFolder(folder)
    const root = await addAndScan(files)
    folder.permission = 'prompt'
    folder.answer = 'denied'
    const visit = createLocalFiles(deps)
    expect(await visit.requestAccess(root.id)).toBe('denied')
    expect(visit.statusOf(root.id)).toEqual({ state: 'denied' })
  })

  it('reads a refused folder again once it is chosen again', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A') })
    const { files, deps } = withFolder(folder)
    const root = await addAndScan(files)
    folder.permission = 'denied'
    const visit = createLocalFiles(deps)
    await visit.checkRoots()
    expect(visit.statusOf(root.id)).toEqual({ state: 'denied' })
    // Picking the folder grants access to it anew.
    folder.permission = 'granted'
    folder.put('b.flac', flac('B'))
    expect(await visit.addFolder({ replace: root.id })).toMatchObject({
      status: 'replaced',
      root: { id: root.id },
    })
    await visit.whenScanned(root.id)
    expect(visit.statusOf(root.id)).toEqual({ state: 'ready' })
    expect(await visit.repo.countFiles(root.id)).toBe(2)
  })
})

describe('picked files', () => {
  const pickFolder = (name: string, files: Record<string, File>) =>
    Object.entries(files).map(([path, file]) => inFolder(file, `${name}/${path}`))

  it('lists a chosen folder under its name, and only while the page lives', async () => {
    const { files, deps } = testLocalFiles({ canKeepFolders: () => false })
    const result = await files.addPicked(
      pickFolder('Music', {
        'Album/a.flac': flac('A'),
        'Album/cover.jpg': audioFile(new Uint8Array(4), 'cover.jpg'),
      }),
    )
    if (result.status !== 'added') throw new Error(result.status)
    expect(result.root).toMatchObject({ kind: 'picked-folder', name: 'Music' })
    await files.whenScanned(result.root.id)
    const [file] = await files.repo.filesOfRoot(result.root.id)
    expect(file?.path).toBe('Album/a.flac')
    expect(files.statusOf(result.root.id)).toEqual({ state: 'ready' })
    // After a reload the files are gone until chosen again.
    const visit = createLocalFiles(deps)
    await visit.checkRoots()
    expect(visit.statusOf(result.root.id)).toEqual({ state: 'unavailable' })
    // Skipped, not stopped: nothing in a queue can bring them back.
    const error = await errorOf(visit.streamFor(file?.id ?? ''))
    expect(isFxmError(error, 'Unavailable')).toBe(true)
    expect((error as Error).message).toBe('Choose “Music” again to play this song')
  })

  it('brings the songs of a folder chosen again back with their IDs', async () => {
    const { files, deps } = testLocalFiles({ canKeepFolders: () => false })
    const first = await files.addPicked(
      pickFolder('Music', { 'a.flac': flac('A'), 'b.flac': flac('B') }),
    )
    if (first.status !== 'added') throw new Error(first.status)
    await files.whenScanned(first.root.id)
    const before = await files.repo.filesOfRoot(first.root.id)
    const visit = createLocalFiles(deps)
    const again = await visit.addPicked(pickFolder('Music', { 'a.flac': flac('A') }))
    expect(again).toMatchObject({ status: 'updated', root: { id: first.root.id } })
    await visit.whenScanned(first.root.id)
    const after = await visit.repo.filesOfRoot(first.root.id)
    expect(after.map((file) => file.id)).toEqual([
      before.find((file) => file.path === 'a.flac')?.id,
    ])
    expect((await visit.streamFor(after[0]?.id ?? '')).url).toMatch(/^blob:/)
  })

  it('adds single files up under “Chosen files”', async () => {
    const { files } = testLocalFiles()
    const first = await files.addPicked([flac('A')])
    if (first.status !== 'added') throw new Error(first.status)
    expect(first.root).toMatchObject({ kind: 'picked-files', name: 'Chosen files' })
    await files.whenScanned(first.root.id)
    await files.addPicked([mp3('B')])
    await files.whenScanned(first.root.id)
    const listed = await files.repo.filesOfRoot(first.root.id)
    expect(listed).toHaveLength(2)
    for (const file of listed) expect((await files.streamFor(file.id)).url).toMatch(/^blob:/)
  })

  it('says when none of the files can be played', async () => {
    const { files } = testLocalFiles()
    expect(await files.addPicked([audioFile(new Uint8Array(3), 'notes.txt')])).toEqual({
      status: 'empty',
    })
  })
})

describe('opening files to play', () => {
  it('hands out object URLs with the format, lossless only for lossless files', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A'), 'b.mp3': mp3('B') })
    const { files, objectUrls } = withFolder(folder)
    const root = await addAndScan(files)
    const listed = await files.repo.filesOfRoot(root.id)
    const id = (path: string) => listed.find((file) => file.path === path)?.id ?? ''
    const lossless = await files.streamFor(id('a.flac'))
    expect(lossless).toEqual({
      url: 'blob:fxm-test/1',
      codec: 'flac',
      container: 'flac',
      media: 'audio',
      tier: 'lossless',
      protocol: 'progressive',
      ipBound: false,
      fullLength: 'verified',
      bitrateKbps: expect.any(Number),
      sampleRateHz: 44_100,
      bitDepth: 16,
    })
    const lossy = await files.streamFor(id('b.mp3'))
    expect(lossy).toMatchObject({ codec: 'mp3', container: 'mp3', tier: 'normal' })
    expect(lossy.bitDepth).toBeUndefined()
    // The same unchanged file gets the same URL.
    expect((await files.streamFor(id('a.flac'))).url).toBe(lossless.url)
    expect(objectUrls.created).toHaveLength(2)
  })

  it('says when the file is gone', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A') })
    const { files } = withFolder(folder)
    const root = await addAndScan(files)
    const [file] = await files.repo.filesOfRoot(root.id)
    folder.delete('a.flac')
    const error = await errorOf(files.streamFor(file?.id ?? ''))
    expect(isFxmError(error, 'NotFound')).toBe(true)
    expect(isFxmError(await errorOf(files.streamFor('nope')), 'NotFound')).toBe(true)
  })

  it('asks for access to the folder, and says when it is refused', async () => {
    const folder = fakeFolder('Music', { 'a.flac': flac('A') })
    const { files } = withFolder(folder)
    const root = await addAndScan(files)
    const [file] = await files.repo.filesOfRoot(root.id)
    folder.permission = 'prompt'
    expect((await files.streamFor(file?.id ?? '')).url).toMatch(/^blob:/)
    expect(folder.requests).toBe(1)
    folder.permission = 'prompt'
    folder.answer = 'denied'
    const error = await errorOf(files.streamFor(file?.id ?? ''))
    expect(isFxmError(error, 'AuthRequired')).toBe(true)
    expect((error as Error).message).toBe('Allow FXM to read “Music” to play this song')
    expect(files.statusOf(root.id)).toEqual({ state: 'denied' })
  })
})

describe('removing', () => {
  it('forgets a root, its files, handle and covers', async () => {
    const folder = fakeFolder('Music', {
      'a.flac': audioFile(
        flacFile({
          tags: { title: 'A' },
          picture: { data: pngImage([4, 5, 6]), mime: 'image/png' },
        }),
        'a.flac',
      ),
    })
    const { files } = withFolder(folder)
    const root = await addAndScan(files)
    expect((await files.repo.pictureKeys()).size).toBe(1)
    await files.removeRoot(root.id)
    expect(await files.repo.listRoots()).toEqual([])
    expect(await files.repo.listFiles()).toEqual([])
    expect(await files.repo.handles.get(root.id)).toBeUndefined()
    expect(files.statusOf(root.id)).toEqual({ state: 'checking' })
    await files.settled()
    expect((await files.repo.pictureKeys()).size).toBe(0)
  })

  it('stops a running scan first', async () => {
    const folder = fakeFolder(
      'Music',
      Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [`${index}.flac`, flac(`${index}`)]),
      ),
    )
    const { files } = withFolder(folder)
    const result = await files.addFolder()
    if (result.status !== 'added') throw new Error(result.status)
    await files.removeRoot(result.root.id)
    expect(await files.repo.listFiles()).toEqual([])
  })
})
