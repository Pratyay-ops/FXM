import { describe, expect, it, vi } from 'vitest'
import { walkDirectory } from './file-system'
import { newTrackNativeId } from './ids'
import { type ScanDeps, type ScanOptions, scanRoot } from './scanner'
import { READER_VERSION, readTags } from './tags'
import {
  asHandle,
  audioFile,
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

function setup() {
  const { deps } = testLocalFilesDeps()
  const read = vi.fn(readTags)
  const thumbnail = vi.fn(fakeThumbnail)
  const scanDeps: ScanDeps = { repo: deps.repo, readTags: read, thumbnail, now: deps.now }
  const scan = (folder: ReturnType<typeof fakeFolder>, options: Partial<ScanOptions> = {}) =>
    scanRoot(scanDeps, {
      root: ROOT,
      directories: walkDirectory(asHandle(folder)),
      complete: true,
      ...options,
    })
  return { repo: deps.repo, read, thumbnail, scan }
}

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
    const progress: { found: number; read: number }[] = []
    await scan(folder, { onProgress: (step) => progress.push(step) })
    expect(progress[0]).toEqual({ found: 2, read: 0 })
    expect(progress.at(-1)).toEqual({ found: 2, read: 2 })
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

  it('keeps the IDs of files from folders it absorbs', async () => {
    const { repo, scan } = setup()
    const inner: LocalRootRecord = { id: 'root-0', kind: 'folder', name: 'Jazz', addedAt: 0 }
    const jazz = fakeFolder('Jazz', { 'a.flac': song('A') })
    await scanRoot(
      { repo, readTags, thumbnail: fakeThumbnail, now: () => 1 },
      { root: inner, directories: walkDirectory(asHandle(jazz)), complete: true },
    )
    const [old] = await repo.filesOfRoot(inner.id)
    const music = fakeFolder('Music', { 'Jazz/a.flac': song('A') })
    const outcome = await scan(music, { absorb: await repo.filesOfRoot(inner.id) })
    expect(outcome).toMatchObject({ moved: 1, added: 0 })
    expect(await repo.filesOfRoot(inner.id)).toEqual([])
    expect((await repo.filesOfRoot(ROOT.id))[0]?.id).toBe(old?.id)
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
