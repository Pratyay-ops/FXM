import { describe, expect, it, vi } from 'vitest'
import { walkDirectory } from './file-system'
import { newTrackNativeId } from './ids'
import { forEachLimit, type ScanDeps, type ScanOptions, scanRoot } from './scanner'
import { READER_VERSION, type ReadTags, readTags } from './tags'
import {
  asHandle,
  audioFile,
  domError,
  fakeFolder,
  fakeThumbnail,
  flacFile,
  mp3File,
  pngImage,
  testLocalFilesDeps,
  wavFile,
} from './testing'
import type { LocalRootRecord } from './types'

const ROOT: LocalRootRecord = { id: 'root-1', kind: 'folder', name: 'Music', addedAt: 1 }
const RED = pngImage([220, 30, 30])
const BLUE = pngImage([30, 30, 220])

function song(
  title: string,
  extra: { album?: string; track?: number; lastModified?: number } = {},
) {
  const bytes = flacFile({
    tags: {
      title,
      artists: ['Aria Vale'],
      album: extra.album ?? 'Neon Rivers',
      track: extra.track ?? 1,
    },
  })
  return audioFile(bytes, `${title}.flac`, { lastModified: extra.lastModified ?? 1000 })
}

function setup({ read = vi.fn(readTags) }: { read?: ReadTags } = {}) {
  const { deps } = testLocalFilesDeps()
  const thumbnail = vi.fn(fakeThumbnail)
  const scanDeps: ScanDeps = { repo: deps.repo, readTags: read, thumbnail, now: deps.now }
  const scan = (folder: ReturnType<typeof fakeFolder>, options: Partial<ScanOptions> = {}) =>
    scanRoot(scanDeps, {
      root: ROOT,
      directories: walkDirectory(asHandle(folder)),
      complete: true,
      ...options,
    })
  return { repo: deps.repo, read, thumbnail, scan, scanDeps }
}

/** A tag reader that reads nothing: every file is a FLAC titled after its name. */
const quickRead: ReadTags = async (_file, name) => ({
  ok: true,
  tags: { title: name, artists: [] },
  format: { codec: 'flac', container: 'flac', tier: 'lossless' },
})

describe('scanRoot', () => {
  it('lists the audio files of a folder and its subfolders, with tags and formats', async () => {
    const { repo, scan } = setup()
    const folder = fakeFolder('Music', {
      'Aria Vale/Neon Rivers/01 Night Drive.flac': song('Night Drive', { track: 1 }),
      'Aria Vale/Neon Rivers/02 Slow Tide.flac': song('Slow Tide', { track: 2 }),
      'Singles/Room Tone.wav': audioFile(
        wavFile({ tags: { title: 'Room Tone' } }),
        'Room Tone.wav',
      ),
      'Singles/notes.txt': audioFile(new Uint8Array(3), 'notes.txt'),
      '.hidden/secret.mp3': audioFile(mp3File(), 'secret.mp3'),
      'Singles/.DS_Store': audioFile(new Uint8Array(3), '.DS_Store'),
    })
    const outcome = await scan(folder)
    expect(outcome).toMatchObject({ status: 'done', added: 3, updated: 0, removed: 0, moved: 0 })
    const files = await repo.filesOfRoot(ROOT.id)
    expect(files.map((file) => file.path).sort()).toEqual([
      'Aria Vale/Neon Rivers/01 Night Drive.flac',
      'Aria Vale/Neon Rivers/02 Slow Tide.flac',
      'Singles/Room Tone.wav',
    ])
    const night = files.find((file) => file.tags.title === 'Night Drive')
    expect(night).toMatchObject({
      key: 'root-1/Aria Vale/Neon Rivers/01 Night Drive.flac',
      rootId: 'root-1',
      id: newTrackNativeId('Music', 'Aria Vale/Neon Rivers/01 Night Drive.flac'),
      readerVersion: READER_VERSION,
      format: { codec: 'flac', container: 'flac', tier: 'lossless' },
    })
    expect(outcome.changed).toHaveLength(3)
  })

  it('reports progress as it goes', async () => {
    const { scan } = setup()
    const folder = fakeFolder('Music', { 'a.flac': song('A'), 'b.flac': song('B') })
    const progress: { found: number; read: number; walked: boolean }[] = []
    await scan(folder, { onProgress: (step) => progress.push(step) })
    expect(progress[0]).toEqual({ found: 2, read: 0, walked: false })
    expect(progress.at(-1)).toEqual({ found: 2, read: 2, walked: true })
  })

  it('finds every file before it says how many there are', async () => {
    const { scan } = setup()
    const folder = fakeFolder('Music', {
      'A/1.flac': song('One'),
      'A/2.flac': song('Two'),
      'B/3.flac': song('Three'),
      'C/D/4.flac': song('Four'),
    })
    const progress: { found: number; read: number; walked: boolean }[] = []
    await scan(folder, { onProgress: (step) => progress.push(step) })
    // Until the walk is over the count grows folder by folder; after it, it is the total.
    const walked = progress.filter((step) => step.walked)
    expect(walked.length).toBeGreaterThan(0)
    expect(walked.every((step) => step.found === 4)).toBe(true)
    expect(progress.filter((step) => !step.walked).every((step) => step.found <= 4)).toBe(true)
    expect(progress.at(-1)).toEqual({ found: 4, read: 4, walked: true })
  })

  it('reads an unchanged file only once', async () => {
    const { read, scan } = setup()
    const folder = fakeFolder('Music', { 'a.flac': song('A'), 'b.flac': song('B') })
    await scan(folder)
    expect(read).toHaveBeenCalledTimes(2)
    const again = await scan(folder)
    expect(read).toHaveBeenCalledTimes(2)
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 2, removed: 0, changed: [] })
  })

  it('reads a changed file again and keeps its ID', async () => {
    const { repo, read, scan } = setup()
    const folder = fakeFolder('Music', { 'a.flac': song('A') })
    await scan(folder)
    const [before] = await repo.filesOfRoot(ROOT.id)
    folder.put('a.flac', song('A (Remastered)', { lastModified: 2000 }))
    const outcome = await scan(folder)
    const [after] = await repo.filesOfRoot(ROOT.id)
    expect(read).toHaveBeenCalledTimes(2)
    expect(outcome).toMatchObject({ added: 0, updated: 1 })
    expect(after?.id).toBe(before?.id)
    expect(after?.tags.title).toBe('A (Remastered)')
    expect(after?.addedAt).toBe(before?.addedAt)
  })

  it('forgets files that are gone', async () => {
    const { repo, scan } = setup()
    const folder = fakeFolder('Music', { 'a.flac': song('A'), 'b.flac': song('B') })
    await scan(folder)
    folder.delete('b.flac')
    const outcome = await scan(folder)
    expect(outcome).toMatchObject({ removed: 1, moved: 0 })
    expect((await repo.filesOfRoot(ROOT.id)).map((file) => file.path)).toEqual(['a.flac'])
  })

  it('keeps the ID of a file that moved', async () => {
    const { repo, scan } = setup()
    const folder = fakeFolder('Music', { 'Inbox/a.flac': song('A') })
    await scan(folder)
    const [before] = await repo.filesOfRoot(ROOT.id)
    folder.move('Inbox/a.flac', 'Aria Vale/Neon Rivers/01 A.flac')
    const outcome = await scan(folder)
    const files = await repo.filesOfRoot(ROOT.id)
    expect(outcome).toMatchObject({ added: 0, moved: 1, removed: 0 })
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('Aria Vale/Neon Rivers/01 A.flac')
    expect(files[0]?.id).toBe(before?.id)
    expect(outcome.changed.map((file) => file.id)).toEqual([before?.id])
  })

  it('removes nothing when cancelled', async () => {
    const { repo, scan } = setup()
    const folder = fakeFolder('Music', { 'a.flac': song('A'), 'b.flac': song('B') })
    await scan(folder)
    folder.delete('b.flac')
    const controller = new AbortController()
    controller.abort()
    const outcome = await scan(folder, { signal: controller.signal })
    expect(outcome.status).toBe('cancelled')
    expect(await repo.filesOfRoot(ROOT.id)).toHaveLength(2)
  })

  it('stops a walk that is cancelled while it runs, keeping what it read', async () => {
    const { repo } = setup()
    const folder = fakeFolder('Music', { 'A/a.flac': song('A'), 'B/b.flac': song('B') })
    const controller = new AbortController()
    const outcome = await scanRoot(
      { repo, readTags, thumbnail: fakeThumbnail, now: () => 1 },
      {
        root: ROOT,
        directories: walkDirectory(asHandle(folder), controller.signal),
        complete: true,
        signal: controller.signal,
        onProgress: ({ read }) => {
          if (read === 1) controller.abort()
        },
      },
    )
    expect(outcome.status).toBe('cancelled')
    expect((await repo.filesOfRoot(ROOT.id)).map((file) => file.path)).toEqual(['A/a.flac'])
  })

  it('adds up when the files are not the whole root', async () => {
    const { repo, scan } = setup()
    await scan(fakeFolder('Music', { 'a.flac': song('A') }), { complete: false })
    await scan(fakeFolder('Music', { 'b.flac': song('B') }), { complete: false })
    expect(await repo.filesOfRoot(ROOT.id)).toHaveLength(2)
  })

  it('counts the files it leaves out, by reason', async () => {
    const { repo, scan } = setup()
    const folder = fakeFolder('Music', {
      'good.flac': song('Good'),
      'broken.flac': audioFile(new Uint8Array(100).fill(9), 'broken.flac'),
      'fake.mp3': audioFile(new TextEncoder().encode('just text, not audio'), 'fake.mp3'),
    })
    const outcome = await scan(folder)
    expect(outcome.added).toBe(1)
    expect((outcome.skipped.unreadable ?? 0) + (outcome.skipped.unsupported ?? 0)).toBe(2)
    expect(await repo.filesOfRoot(ROOT.id)).toHaveLength(1)
  })

  it('makes one thumbnail per cover, embedded or from the folder', async () => {
    const { repo, thumbnail, scan } = setup()
    const embedded = (title: string) =>
      audioFile(
        flacFile({ tags: { title }, picture: { data: RED, mime: 'image/png' } }),
        `${title}.flac`,
      )
    const folder = fakeFolder('Music', {
      'Red/1.flac': embedded('One'),
      'Red/2.flac': embedded('Two'),
      'Blue/3.flac': song('Three'),
      'Blue/4.flac': song('Four'),
      'Blue/cover.png': audioFile(BLUE, 'cover.png'),
      'Blue/back.png': audioFile(RED, 'back.png'),
      'Plain/5.flac': song('Five'),
    })
    await scan(folder)
    expect(thumbnail).toHaveBeenCalledTimes(2)
    const files = await repo.filesOfRoot(ROOT.id)
    const key = (title: string) => files.find((file) => file.tags.title === title)?.pictureKey
    expect(key('One')).toBeDefined()
    expect(key('One')).toBe(key('Two'))
    expect(key('Three')).toBeDefined()
    expect(key('Three')).toBe(key('Four'))
    expect(key('Three')).not.toBe(key('One'))
    expect(key('Five')).toBeUndefined()
    const pictures = await repo.getPictures([key('One') ?? '', key('Three') ?? ''])
    expect(pictures.size).toBe(2)
  })

  it('covers unchanged files with a folder image added later', async () => {
    const { repo, read, scan } = setup()
    const folder = fakeFolder('Music', { 'Album/1.flac': song('One') })
    await scan(folder)
    folder.put('Album/folder.jpg', audioFile(BLUE, 'folder.jpg'))
    await scan(folder)
    expect(read).toHaveBeenCalledTimes(1)
    expect((await repo.filesOfRoot(ROOT.id))[0]?.pictureKey).toBeDefined()
  })

  it('leaves out a file that fails while it is read, and goes on', async () => {
    const read = vi.fn<ReadTags>(async (file, name) => {
      if (name === 'b.flac') throw domError('NotReadableError')
      return readTags(file, name)
    })
    const { repo, scan } = setup({ read })
    const folder = fakeFolder('Music', {
      'a.flac': song('A'),
      'b.flac': song('B'),
      'c.flac': song('C'),
    })
    const outcome = await scan(folder)
    expect(outcome).toMatchObject({ status: 'done', added: 2, skipped: { unreadable: 1 } })
    expect((await repo.filesOfRoot(ROOT.id)).map((file) => file.path).sort()).toEqual([
      'a.flac',
      'c.flac',
    ])
  })

  it('fails when it can’t write, and reports nothing after that', async () => {
    const { repo, scanDeps } = setup({ read: quickRead })
    vi.spyOn(repo, 'applyFiles').mockRejectedValue(domError('QuotaExceededError'))
    const folder = fakeFolder(
      'Music',
      Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`${index}.flac`, song('S')])),
    )
    const progress: number[] = []
    const scan = scanRoot(scanDeps, {
      root: ROOT,
      directories: walkDirectory(asHandle(folder)),
      complete: true,
      onProgress: ({ read }) => progress.push(read),
    })
    await expect(scan).rejects.toMatchObject({ name: 'QuotaExceededError' })
    const reported = progress.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(progress).toHaveLength(reported)
  })

  it('keeps the songs of a subfolder it can’t list this time', async () => {
    const { repo, scan } = setup()
    const folder = fakeFolder('Music', { 'A/a.flac': song('A'), 'B/b.flac': song('B') })
    await scan(folder)
    folder.folder('B').listError = domError('NotReadableError')
    const outcome = await scan(folder)
    expect(outcome).toMatchObject({ status: 'done', removed: 0 })
    expect(await repo.filesOfRoot(ROOT.id)).toHaveLength(2)
    // Once it is gone for real, its songs go too.
    folder.delete('B')
    expect(await scan(folder)).toMatchObject({ removed: 1 })
  })

  it('makes a cover again when its thumbnail went missing', async () => {
    const { repo, read, thumbnail, scan } = setup()
    const folder = fakeFolder('Music', {
      'a.flac': audioFile(
        flacFile({ tags: { title: 'A' }, picture: { data: RED, mime: 'image/png' } }),
        'a.flac',
      ),
    })
    await scan(folder)
    const [before] = await repo.filesOfRoot(ROOT.id)
    await repo.db.pictures.clear()
    await scan(folder)
    expect(read).toHaveBeenCalledTimes(2)
    expect(thumbnail).toHaveBeenCalledTimes(2)
    const [after] = await repo.filesOfRoot(ROOT.id)
    expect(after?.id).toBe(before?.id)
    expect(after?.pictureKey).toBe(before?.pictureKey)
    expect(await repo.hasPicture(after?.pictureKey ?? '')).toBe(true)
    // With its thumbnail back, the file is unchanged again.
    await scan(folder)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('writes the first songs soon, then in bigger batches', async () => {
    const { repo, scanDeps } = setup({ read: quickRead })
    const write = vi.spyOn(repo, 'applyFiles')
    const folder = fakeFolder(
      'Music',
      Object.fromEntries(
        Array.from({ length: 250 }, (_, index) => [
          `${String(index).padStart(3, '0')}.flac`,
          song('S'),
        ]),
      ),
    )
    // A clock that stands still, and batches that never get old: only their sizes decide.
    await scanRoot(
      { ...scanDeps, now: () => 0 },
      {
        root: ROOT,
        directories: walkDirectory(asHandle(folder)),
        complete: true,
        batchMs: 600_000,
        laterBatchMs: 600_000,
      },
    )
    const sizes = write.mock.calls.map(([changes]) => changes.put?.length ?? 0).filter(Boolean)
    expect(sizes).toEqual([100, 150])
  })

  it('writes what it read on time while a slow file holds the scan up', async () => {
    let clock = 0
    let release = () => {}
    const slow = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = vi.fn<ReadTags>(async (file, name) => {
      if (name === 'slow.flac') await slow
      return quickRead(file, name)
    })
    const { repo, scanDeps } = setup({ read })
    const folder = fakeFolder('Music', { 'a.flac': song('A'), 'slow.flac': song('Slow') })
    const scan = scanRoot(
      { ...scanDeps, now: () => clock },
      {
        root: ROOT,
        directories: walkDirectory(asHandle(folder)),
        complete: true,
        batchMs: 20,
        concurrency: 1,
      },
    )
    // a.flac is read, then slow.flac waits: a.flac is listed anyway, once its batch is due.
    await vi.waitFor(async () => {
      clock += 10
      expect((await repo.filesOfRoot(ROOT.id)).map((file) => file.path)).toEqual(['a.flac'])
    })
    release()
    expect(await scan).toMatchObject({ status: 'done', added: 2 })
    expect(await repo.filesOfRoot(ROOT.id)).toHaveLength(2)
  })

  it('gives a new file a free ID when its hash is taken by a moved file', async () => {
    const { repo, scan } = setup()
    const folder = fakeFolder('Music', { 'a.flac': song('A') })
    await scan(folder)
    const [first] = await repo.filesOfRoot(ROOT.id)
    folder.move('a.flac', 'moved/a.flac')
    await scan(folder)
    folder.put('a.flac', song('A new song', { lastModified: 5 }))
    await scan(folder)
    const files = await repo.filesOfRoot(ROOT.id)
    expect(new Set(files.map((file) => file.id)).size).toBe(2)
    expect(files.find((file) => file.path === 'moved/a.flac')?.id).toBe(first?.id)
  })
})

describe('forEachLimit', () => {
  it('starts nothing after a failure, waits for what runs, then throws', async () => {
    const started: number[] = []
    const finished: number[] = []
    const run = forEachLimit([0, 1, 2, 3, 4, 5], 2, async (item) => {
      started.push(item)
      await new Promise((resolve) => setTimeout(resolve, item === 1 ? 20 : 1))
      if (item === 0) throw new Error('first')
      finished.push(item)
    })
    await expect(run).rejects.toThrow('first')
    expect(started).toEqual([0, 1])
    expect(finished).toEqual([1])
  })
})
