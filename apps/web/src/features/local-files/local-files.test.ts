import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { createLocalFiles } from './local-files'
import {
  asHandle,
  audioFile,
  type FakeDirectoryHandle,
  fakeFolder,
  flacFile,
  inFolder,
  mp3File,
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

  it('replaces folders inside a new one, keeping their songs’ IDs', async () => {
    const music = fakeFolder('Music', { 'Jazz/a.flac': flac('A'), 'Pop/b.flac': flac('B') })
    let pick = music.folder('Jazz')
    const { files } = testLocalFiles({ pickDirectory: async () => asHandle(pick) })
    const jazz = await addAndScan(files)
    const [song] = await files.repo.filesOfRoot(jazz.id)
    pick = music
    const root = await addAndScan(files)
    expect((await files.repo.listRoots()).map((each) => each.id)).toEqual([root.id])
    const listed = await files.repo.filesOfRoot(root.id)
    expect(listed).toHaveLength(2)
    expect(listed.find((file) => file.path === 'Jazz/a.flac')?.id).toBe(song?.id)
    expect(await files.repo.handles.get(jazz.id)).toBeUndefined()
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
    await files.whenScanned(result.root.id)
    expect(files.statusOf(result.root.id)).toEqual({ state: 'ready' })
    expect((await files.repo.getRoot(result.root.id))?.scannedAt).toBeUndefined()
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
    const error = await errorOf(visit.streamFor(file?.id ?? ''))
    expect(isFxmError(error, 'AuthRequired')).toBe(true)
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
    const folder = fakeFolder('Music', { 'a.flac': flac('A') })
    const { files } = withFolder(folder)
    const root = await addAndScan(files)
    await files.removeRoot(root.id)
    expect(await files.repo.listRoots()).toEqual([])
    expect(await files.repo.listFiles()).toEqual([])
    expect(await files.repo.handles.get(root.id)).toBeUndefined()
    expect(files.statusOf(root.id)).toEqual({ state: 'checking' })
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
