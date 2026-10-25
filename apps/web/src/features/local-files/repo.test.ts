import { describe, expect, it } from 'vitest'
import { fileRecord, testLocalFilesDeps } from './testing'
import type { LocalRootRecord } from './types'

const ROOT: LocalRootRecord = { id: 'r1', kind: 'folder', name: 'Music', addedAt: 1 }
const PICKED: LocalRootRecord = { id: 'r2', kind: 'picked-folder', name: 'Music', addedAt: 2 }
const picture = (key: string) => ({ key, url: `data:${key}`, width: 1, height: 1 })

describe('the local-files repository', () => {
  it('lists roots oldest first and finds picked roots by kind and name', async () => {
    const { repo } = testLocalFilesDeps().deps
    await repo.putRoot(PICKED)
    await repo.putRoot(ROOT)
    expect((await repo.listRoots()).map((root) => root.id)).toEqual(['r1', 'r2'])
    expect(await repo.findPickedRoot('picked-folder', 'Music')).toEqual(PICKED)
    expect(await repo.findPickedRoot('picked-files', 'Music')).toBeUndefined()
  })

  it('finds files by root, native ID and ISRC', async () => {
    const { repo } = testLocalFilesDeps().deps
    const a = fileRecord({ title: 'A', isrc: 'USXYZ2100001' }, { rootId: 'r1', id: 'a' })
    const b = fileRecord({ title: 'B' }, { rootId: 'r2', id: 'b' })
    await repo.applyFiles({ put: [a, b] })
    expect(await repo.filesOfRoot('r1')).toEqual([a])
    expect(await repo.fileById('b')).toEqual(b)
    expect(await repo.filesByIds(['a', 'b', 'c'])).toHaveLength(2)
    expect(await repo.filesByIsrc('USXYZ2100001')).toEqual([a])
    expect(await repo.nativeIds()).toEqual(new Set(['a', 'b']))
  })

  it('moves a file in one write, and drops covers no file uses only when pruning', async () => {
    const { repo } = testLocalFilesDeps().deps
    const old = fileRecord({ title: 'A' }, { key: 'r1/old.flac', id: 'a', pictureKey: 'p1' })
    await repo.putPicture(picture('p1'))
    await repo.putPicture(picture('p2'))
    await repo.applyFiles({ put: [old] })
    const moved = { ...old, key: 'r1/new.flac', path: 'new.flac', pictureKey: 'p2' }
    await repo.applyFiles({ put: [moved], remove: [old.key] })
    expect(await repo.listFiles()).toEqual([moved])
    // A running scan may have stored a cover for records it hasn't written yet: writes keep it.
    expect(await repo.pictureKeys()).toEqual(new Set(['p1', 'p2']))
    expect(await repo.prunePictures()).toBe(1)
    expect(await repo.pictureKeys()).toEqual(new Set(['p2']))
  })

  it('keeps a cover stored ahead of its records when other files go', async () => {
    const { repo } = testLocalFilesDeps().deps
    const other = fileRecord({ title: 'B' })
    await repo.applyFiles({ put: [other] })
    await repo.putPicture(picture('k1'))
    await repo.applyFiles({ remove: [other.key] })
    expect(await repo.hasPicture('k1')).toBe(true)
  })

  it('removes a root with its files and handle; its covers go when pruning', async () => {
    const { repo } = testLocalFilesDeps().deps
    await repo.putRoot(ROOT)
    await repo.handles.put(ROOT.id, {} as FileSystemDirectoryHandle)
    await repo.putPicture(picture('p1'))
    await repo.applyFiles({
      put: [fileRecord({ title: 'A' }, { rootId: ROOT.id, pictureKey: 'p1' })],
    })
    expect(await repo.countFiles(ROOT.id)).toBe(1)
    await repo.removeRoot(ROOT.id)
    expect(await repo.listRoots()).toEqual([])
    expect(await repo.listFiles()).toEqual([])
    expect(await repo.countFiles(ROOT.id)).toBe(0)
    expect(await repo.handles.get(ROOT.id)).toBeUndefined()
    await repo.prunePictures()
    expect(await repo.hasPicture('p1')).toBe(false)
  })

  it('moves the files of folders inside a new one by path, keeping everything else', async () => {
    const { repo } = testLocalFilesDeps().deps
    const jazz: LocalRootRecord = { id: 'jazz', kind: 'folder', name: 'Jazz', addedAt: 1 }
    const live: LocalRootRecord = { id: 'live', kind: 'folder', name: 'Live', addedAt: 2 }
    await repo.putRoot(jazz)
    await repo.putRoot(live)
    await repo.handles.put('jazz', {} as FileSystemDirectoryHandle)
    const a = fileRecord(
      { title: 'A' },
      { key: 'jazz/a.flac', rootId: 'jazz', path: 'a.flac', id: 'id-a' },
    )
    const b = fileRecord(
      { title: 'B' },
      { key: 'live/x/b.flac', rootId: 'live', path: 'x/b.flac', id: 'id-b' },
    )
    await repo.applyFiles({ put: [a, b] })
    const music: LocalRootRecord = { id: 'music', kind: 'folder', name: 'Music', addedAt: 3 }
    await repo.adoptRoot(music, [
      { rootId: 'jazz', path: 'Jazz' },
      { rootId: 'live', path: 'Jazz/Live' },
    ])
    expect((await repo.listRoots()).map((root) => root.id)).toEqual(['music'])
    expect(await repo.handles.get('jazz')).toBeUndefined()
    const files = await repo.filesOfRoot('music')
    expect(
      files
        .map(({ key, path, id }) => ({ key, path, id }))
        .sort((x, y) => x.id.localeCompare(y.id)),
    ).toEqual([
      { key: 'music/Jazz/a.flac', path: 'Jazz/a.flac', id: 'id-a' },
      { key: 'music/Jazz/Live/x/b.flac', path: 'Jazz/Live/x/b.flac', id: 'id-b' },
    ])
    expect(files.find((file) => file.id === 'id-a')).toMatchObject({
      size: a.size,
      lastModified: a.lastModified,
      tags: a.tags,
    })
  })

  it('moves a root’s own files under the path it has inside its new folder', async () => {
    const { repo } = testLocalFilesDeps().deps
    await repo.putRoot(ROOT)
    const a = fileRecord({ title: 'A' }, { key: 'r1/a.flac', rootId: 'r1', path: 'a.flac' })
    await repo.applyFiles({ put: [a] })
    await repo.adoptRoot({ ...ROOT, name: 'Library' }, [{ rootId: ROOT.id, path: 'Music' }])
    expect(await repo.getRoot(ROOT.id)).toMatchObject({ name: 'Library' })
    expect((await repo.filesOfRoot(ROOT.id)).map((file) => file.key)).toEqual(['r1/Music/a.flac'])
  })

  it('clears everything', async () => {
    const { repo } = testLocalFilesDeps().deps
    await repo.putRoot(ROOT)
    await repo.handles.put(ROOT.id, {} as FileSystemDirectoryHandle)
    await repo.putPicture(picture('p1'))
    await repo.applyFiles({ put: [fileRecord({ title: 'A' })] })
    await repo.clear()
    expect(await repo.listRoots()).toEqual([])
    expect(await repo.listFiles()).toEqual([])
    expect(await repo.hasPicture('p1')).toBe(false)
    expect(await repo.handles.get(ROOT.id)).toBeUndefined()
  })
})
