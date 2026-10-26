import { matchingEval } from '@fxm/core'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkpointStorage,
  emptyCheckpoint,
  fileStore,
  groupFileName,
  groupIdOf,
  memoryStore,
  parseCheckpoint,
  serializeGroup,
} from './store'

type EvalGroup = matchingEval.EvalGroup

const GROUP: EvalGroup = {
  id: 'sp:0VjIjW4GlUZAMYd2vXMi3b',
  split: 'held-out',
  categories: ['mainstream'],
  provenance: ['test'],
  variants: [{ slice: 'spotify', source: { title: 'Song', artists: [{ name: 'Artist' }] } }],
}

/** Node's `fs/promises`, for the temporary folder. */
async function fs(): Promise<{
  mkdtemp(prefix: string): Promise<string>
  rm(path: string, options: { recursive: true; force: true }): Promise<void>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  readdir(path: string): Promise<string[]>
}> {
  const specifier = 'node:fs/promises'
  return import(/* @vite-ignore */ specifier)
}

describe('file names', () => {
  it('turn a group ID into a file name and back', () => {
    expect(groupFileName('sp:0VjIjW4GlUZAMYd2vXMi3b')).toBe('sp-0VjIjW4GlUZAMYd2vXMi3b.json')
    expect(groupIdOf('sp-0VjIjW4GlUZAMYd2vXMi3b.json')).toBe('sp:0VjIjW4GlUZAMYd2vXMi3b')
    expect(groupIdOf('fx-squatter-gbaye0601696.json')).toBe('fx:squatter-gbaye0601696')
    expect(groupIdOf('csv-row-3.json')).toBe('csv:row-3')
    expect(groupIdOf('README.md')).toBeUndefined()
    expect(groupIdOf('sp-x.json.tmp')).toBeUndefined()
  })

  it('write a group as two-space JSON with a final newline', () => {
    expect(serializeGroup(GROUP)).toBe(`${JSON.stringify(GROUP, null, 2)}\n`)
  })
})

describe('the checkpoint', () => {
  it('reads back what it wrote, and starts afresh from anything else', () => {
    const checkpoint = emptyCheckpoint()
    checkpoint.record.done['sp:a'] = '0123456789abcdef'
    checkpoint.record.deferred['sp:b'] = { attempts: 2, error: 'FxmError: offline' }
    checkpoint.inputs.pools['playlist:x'] = [{ id: 'a', title: 'A', artists: ['B'] }]
    checkpoint.inputs.readAt['playlist:x'] = '2026-10-26'
    checkpoint.requests.youtube = 3
    expect(parseCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toEqual(checkpoint)
    expect(parseCheckpoint({ version: 2 })).toEqual(emptyCheckpoint())
    expect(parseCheckpoint('nope')).toEqual(emptyCheckpoint())
  })

  it('starts each malformed section afresh, keeping the others', () => {
    const parsed = parseCheckpoint({
      version: 1,
      budget: { 'fxm.requestBudget': '{"v":1}', broken: 7 },
      inputs: {
        plan: 'full',
        pools: { good: [{ id: 'a', title: 'A', artists: ['B'] }], bad: [{ id: 'a' }], odd: 'x' },
        readAt: 'yesterday',
        failed: { 'sp:x': 'FxmError: gone', 'sp:y': 1 },
      },
      record: { done: 'sp:a', deferred: { 'sp:b': { attempts: '2', error: 'x' } } },
      requests: { youtube: '12', spotify: 4, musicbrainz: -1 },
      updatedAt: 5,
    })
    expect(parsed).toEqual({
      ...emptyCheckpoint(),
      budget: { 'fxm.requestBudget': '{"v":1}' },
      inputs: {
        plan: 'full',
        pools: { good: [{ id: 'a', title: 'A', artists: ['B'] }] },
        readAt: {},
        failed: { 'sp:x': 'FxmError: gone' },
      },
      requests: { youtube: 0, spotify: 4, musicbrainz: 0 },
    })
  })

  it('checks the groups of an older checkpoint again', () => {
    const old = { ...emptyCheckpoint(), record: { done: ['sp:a', 3], deferred: {} } }
    expect(parseCheckpoint(old).record.done).toEqual({ 'sp:a': '' })
  })

  it("holds the request budget's storage", () => {
    const checkpoint = emptyCheckpoint()
    const storage = checkpointStorage(checkpoint)
    expect(storage.getItem('fxm.requestBudget')).toBeNull()
    storage.setItem('fxm.requestBudget', '{"v":1}')
    expect(checkpoint.budget).toEqual({ 'fxm.requestBudget': '{"v":1}' })
    storage.removeItem('fxm.requestBudget')
    expect(checkpoint.budget).toEqual({})
  })
})

describe('memoryStore', () => {
  it('checks every group it writes', async () => {
    const store = memoryStore()
    await store.writeGroup(GROUP)
    expect(await store.listGroups()).toEqual([GROUP.id])
    await expect(
      store.writeGroup({ ...GROUP, split: 'test' } as unknown as EvalGroup),
    ).rejects.toThrow(matchingEval.EvalFixtureError)
  })
})

describe('fileStore', async () => {
  const node = await fs()
  const root = await node.mkdtemp('/tmp/fxm-eval-store-')
  const evalDir = new URL(`file://${root}/eval/`)
  const stateDir = new URL(`file://${root}/state/`)
  const store = fileStore({ evalDir, stateDir })

  afterAll(async () => {
    await node.rm(root, { recursive: true, force: true })
  })

  it('starts empty', async () => {
    expect(await store.listGroups()).toEqual([])
    expect(await store.readGroup(GROUP.id)).toBeUndefined()
    expect(await store.readCheckpoint()).toEqual(emptyCheckpoint())
    expect(await store.readText('REVIEW.csv')).toBeUndefined()
  })

  it('writes groups, the checkpoint and texts whole, leaving no temporary file', async () => {
    await store.writeGroup(GROUP)
    expect(await store.listGroups()).toEqual([GROUP.id])
    expect(await store.readGroup(GROUP.id)).toEqual(GROUP)
    expect(await node.readdir(`${root}/eval/fixtures/groups`)).toEqual([groupFileName(GROUP.id)])
    const checkpoint = emptyCheckpoint()
    checkpoint.record.done[GROUP.id] = 'fingerprint'
    await store.writeCheckpoint(checkpoint)
    const saved = await store.readCheckpoint()
    expect(saved.record.done).toEqual({ [GROUP.id]: 'fingerprint' })
    expect(saved.updatedAt).not.toBe(emptyCheckpoint().updatedAt)
    await store.writeText('REVIEW.csv', 'a,b\r\n')
    expect(await store.readText('REVIEW.csv')).toBe('a,b\r\n')
    expect(await node.readFile(`${root}/eval/REVIEW.csv`, 'utf8')).toBe('a,b\r\n')
  })
})
