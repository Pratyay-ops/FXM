import { CONNECT_SEEN_KEY, memoryStorage } from '@fxm/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetConnection, useConnection } from './connection'
import { NOTICES_STORAGE_KEY, noticeFor, removedOnPurpose, useNotices } from './notices'
import {
  CONNECT_STATUS,
  closeTestPages,
  DETECTING,
  openTestPlatform,
  readyConnection,
  TIER_CAPABILITIES,
} from './testing'

afterEach(async () => {
  useNotices.setState({ dismissed: [] })
  resetConnection()
  await closeTestPages()
})

describe('noticeFor', () => {
  it('prompts an upgrade for an outdated FXM Connect, per version', () => {
    expect(noticeFor(readyConnection({ connect: CONNECT_STATUS.outdated }))).toEqual({
      kind: 'outdated',
      id: 'outdated:0.0.9',
    })
  })

  it('reports a missing FXM Connect, per version last seen', () => {
    expect(noticeFor(readyConnection({ connect: CONNECT_STATUS.missing }))).toEqual({
      kind: 'missing',
      id: 'missing:0.1.0',
    })
  })

  it('introduces the tiers on a visit without FXM Connect, once Lite has its verdict', () => {
    expect(noticeFor(readyConnection())).toEqual({ kind: 'intro', id: 'intro' })
    expect(
      noticeFor(readyConnection({ capabilities: TIER_CAPABILITIES.lite, lite: 'passed' })),
    ).toEqual({ kind: 'intro', id: 'intro' })
    expect(noticeFor(readyConnection({ lite: 'checking' }))).toBeUndefined()
  })

  it('stays quiet in Full, while detecting, and in the apps', () => {
    expect(
      noticeFor(
        readyConnection({ connect: CONNECT_STATUS.present, capabilities: TIER_CAPABILITIES.full }),
      ),
    ).toBeUndefined()
    expect(noticeFor(DETECTING)).toBeUndefined()
    expect(noticeFor(readyConnection({ platform: 'desktop' }))).toBeUndefined()
  })

  it('speaks up as soon as FXM Connect answered, while the platform is still starting', () => {
    expect(noticeFor({ ...DETECTING, connect: CONNECT_STATUS.outdated, lite: 'checking' })).toEqual(
      { kind: 'outdated', id: 'outdated:0.0.9' },
    )
    // The introduction waits for Lite's verdict, to say the right thing.
    expect(noticeFor({ ...DETECTING, connect: CONNECT_STATUS.absent, lite: 'checking' })).toBe(
      undefined,
    )
  })
})

describe('removedOnPurpose', () => {
  it('forgets FXM Connect and keeps the first-visit invitation away', async () => {
    const storage = memoryStorage()
    storage.setItem(CONNECT_SEEN_KEY, JSON.stringify({ version: '0.1.0', at: 1 }))
    await openTestPlatform({ storage })
    await vi.waitFor(() => expect(useConnection.getState().connect?.state).toBe('missing'))

    removedOnPurpose()

    await vi.waitFor(() => expect(useConnection.getState().connect?.state).toBe('absent'))
    expect(storage.getItem(CONNECT_SEEN_KEY)).toBeNull()
    expect(useNotices.getState().dismissed).toContain('intro')
  })
})

describe('dismissals', () => {
  it('are remembered once each, and persisted', () => {
    useNotices.getState().dismiss('intro')
    useNotices.getState().dismiss('intro')
    expect(useNotices.getState().dismissed).toEqual(['intro'])
    expect(JSON.parse(localStorage.getItem(NOTICES_STORAGE_KEY) ?? '{}')).toMatchObject({
      state: { dismissed: ['intro'] },
    })
  })

  it('keep only the latest few', () => {
    for (let index = 0; index < 25; index += 1) {
      useNotices.getState().dismiss(`outdated:0.0.${index}`)
    }
    expect(useNotices.getState().dismissed).toHaveLength(20)
    expect(useNotices.getState().dismissed.at(-1)).toBe('outdated:0.0.24')
  })

  it('survive bad stored data', async () => {
    localStorage.setItem(
      NOTICES_STORAGE_KEY,
      JSON.stringify({ state: { dismissed: [1, 'x'] }, version: 1 }),
    )
    await useNotices.persist.rehydrate()
    expect(useNotices.getState().dismissed).toEqual(['x'])
  })
})
