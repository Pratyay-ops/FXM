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

  it('moves a file in one write and drops covers no file uses', async () => {
    const { repo } = testLocalFilesDeps().deps
    const old = fileRecord({ title: 'A' }, { key: 'r1/old.flac', id: 'a', pictureKey: 'p1' })
    await repo.putPicture(picture('p1'))
    await repo.putPicture(picture('p2'))
    await repo.applyFiles({ put: [old] })
    const moved = { ...old, key: 'r1/new.flac', path: 'new.flac', pictureKey: 'p2' }
    await repo.applyFiles({ put: [moved], remove: [old.key] })
    expect(await repo.listFiles()).toEqual([moved])
    expect([...(await repo.getPictures(['p1', 'p2'])).keys()]).toEqual(['p2'])
  })

  it('removes a root with its files, handle and unused covers', async () => {
    const { repo } = testLocalFilesDeps().deps
    await repo.putRoot(ROOT)
    await repo.handles.put(ROOT.id, {} as FileSystemDirectoryHandle)
    await repo.putPicture(picture('p1'))
    await repo.applyFiles({
      put: [fileRecord({ title: 'A' }, { rootId: ROOT.id, pictureKey: 'p1' })],
    })
    await repo.removeRoot(ROOT.id)
    expect(await repo.listRoots()).toEqual([])
    expect(await repo.listFiles()).toEqual([])
    expect(await repo.handles.get(ROOT.id)).toBeUndefined()
    expect(await repo.hasPicture('p1')).toBe(false)
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
