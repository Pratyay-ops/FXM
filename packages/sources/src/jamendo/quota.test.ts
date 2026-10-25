import { describe, expect, it, vi } from 'vitest'
import { type JamendoBlock, JamendoQuota, type JamendoQuotaSnapshot } from './quota'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** A quota on a clock the test moves. */
function quotaAt(start = 1_000_000, saved?: JamendoQuotaSnapshot) {
  const clock = { now: start }
  const quota = new JamendoQuota({ now: () => clock.now, ...(saved ? { saved } : {}) })
  return { quota, clock }
}

describe('JamendoQuota', () => {
  it('blocks a client_id whose quota is used up for 15 minutes, then lets a request through', () => {
    const { quota, clock } = quotaAt()
    expect(quota.blocked('abcd1234')).toBeUndefined()
    quota.record('abcd1234', 'quota-exceeded')
    const block: JamendoBlock = {
      reason: 'quota-exceeded',
      since: 1_000_000,
      retryAt: 1_000_000 + 15 * MINUTE,
      strikes: 1,
    }
    expect(quota.blocked('abcd1234')).toEqual(block)
    expect(quota.blocked('other999')).toBeUndefined()
    clock.now += 15 * MINUTE - 1
    expect(quota.blocked('abcd1234')).toEqual(block)
    clock.now += 1
    expect(quota.blocked('abcd1234')).toBeUndefined()
    expect(quota.recorded('abcd1234')).toEqual(block)
  })

  it('waits four times as long after each further refusal, at most a day', () => {
    const { quota, clock } = quotaAt()
    const waits: number[] = []
    for (let refusal = 0; refusal < 6; refusal++) {
      quota.record('abcd1234', 'quota-exceeded')
      const block = quota.recorded('abcd1234')
      waits.push(((block?.retryAt ?? 0) - clock.now) / MINUTE)
      expect(block?.since).toBe(1_000_000)
      clock.now = block?.retryAt ?? 0
    }
    expect(waits).toEqual([15, 60, 240, 960, 1440, 1440])
  })

  it('counts a burst of refusals once, and ignores answers to requests sent before a block', () => {
    const { quota, clock } = quotaAt()
    for (let answer = 0; answer < 4; answer++) quota.record('abcd1234', 'quota-exceeded')
    expect(quota.recorded('abcd1234')).toMatchObject({
      strikes: 1,
      retryAt: clock.now + 15 * MINUTE,
    })
    // A request that started before the quota ran out may still come back fine.
    quota.record('abcd1234', 'ok')
    expect(quota.blocked('abcd1234')).toMatchObject({ strikes: 1 })
    clock.now += 15 * MINUTE
    quota.record('abcd1234', 'quota-exceeded')
    quota.record('abcd1234', 'quota-exceeded')
    expect(quota.recorded('abcd1234')).toMatchObject({
      strikes: 2,
      retryAt: clock.now + 60 * MINUTE,
    })
  })

  it('lifts a block once a request succeeds after the wait', () => {
    const { quota, clock } = quotaAt()
    quota.record('abcd1234', 'quota-exceeded')
    clock.now += 15 * MINUTE
    quota.record('abcd1234', 'ok')
    expect(quota.recorded('abcd1234')).toBeUndefined()
    quota.record('abcd1234', 'quota-exceeded')
    expect(quota.recorded('abcd1234')).toMatchObject({ strikes: 1 })
  })

  it('tries an unknown or suspended client_id again after a wait, like a used-up one', () => {
    const { quota, clock } = quotaAt()
    quota.record('badid000', 'invalid-client-id')
    quota.record('susp0000', 'suspended')
    expect(quota.blocked('badid000')).toEqual({
      reason: 'invalid-client-id',
      since: 1_000_000,
      retryAt: 1_000_000 + 15 * MINUTE,
      strikes: 1,
    })
    expect(quota.blocked('susp0000')).toMatchObject({ reason: 'suspended', strikes: 1 })
    clock.now += 15 * MINUTE
    expect(quota.blocked('badid000')).toBeUndefined()
    expect(quota.blocked('susp0000')).toBeUndefined()
    quota.record('badid000', 'invalid-client-id')
    expect(quota.recorded('badid000')).toMatchObject({
      strikes: 2,
      retryAt: clock.now + 60 * MINUTE,
    })
    quota.record('susp0000', 'ok')
    expect(quota.recorded('susp0000')).toBeUndefined()
  })

  it('replaces a block when Jamendo refuses for another reason', () => {
    const { quota } = quotaAt()
    quota.record('abcd1234', 'invalid-client-id')
    quota.record('abcd1234', 'quota-exceeded')
    expect(quota.recorded('abcd1234')).toMatchObject({ reason: 'quota-exceeded', strikes: 1 })
  })

  it('forgets a block when asked, so that the next request tests the client_id', () => {
    const { quota } = quotaAt()
    const listener = vi.fn()
    quota.onChange(listener)
    quota.record('abcd1234', 'invalid-client-id')
    quota.forget('abcd1234')
    expect(quota.recorded('abcd1234')).toBeUndefined()
    quota.forget('abcd1234')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('tells listeners when a block is recorded or lifted, and stops when asked', () => {
    const { quota, clock } = quotaAt()
    const listener = vi.fn()
    const stop = quota.onChange(listener)
    quota.record('abcd1234', 'ok')
    expect(listener).not.toHaveBeenCalled()
    quota.record('abcd1234', 'quota-exceeded')
    quota.record('abcd1234', 'quota-exceeded')
    clock.now += 15 * MINUTE
    quota.record('abcd1234', 'ok')
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    quota.record('abcd1234', 'invalid-client-id')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('never hands out its own records to change', () => {
    const { quota } = quotaAt()
    quota.record('abcd1234', 'quota-exceeded')
    const block = quota.recorded('abcd1234')
    if (block !== undefined) block.retryAt = 0
    const snapshot = quota.snapshot()
    if (snapshot.abcd1234 !== undefined) snapshot.abcd1234.retryAt = 0
    expect(quota.blocked('abcd1234')).toMatchObject({ retryAt: 1_000_000 + 15 * MINUTE })
  })

  it('saves its blocks and takes them back, dropping anything malformed', () => {
    const { quota } = quotaAt()
    quota.record('abcd1234', 'quota-exceeded')
    quota.record('badid000', 'invalid-client-id')
    const snapshot = quota.snapshot()
    expect(snapshot).toEqual({
      abcd1234: { reason: 'quota-exceeded', since: 1_000_000, retryAt: 1_900_000, strikes: 1 },
      badid000: { reason: 'invalid-client-id', since: 1_000_000, retryAt: 1_900_000, strikes: 1 },
    })
    const saved = {
      ...snapshot,
      broken1: { reason: 'quota-exceeded', since: 'yesterday', retryAt: 1, strikes: 1 },
      broken2: null,
      broken3: { reason: 'banned', since: 1, retryAt: 2, strikes: 1 },
      broken4: { reason: 'suspended' },
      broken5: { reason: 'suspended', since: 1, retryAt: Number.POSITIVE_INFINITY, strikes: 1 },
    } as unknown as JamendoQuotaSnapshot
    const { quota: restored } = quotaAt(1_000_000, saved)
    expect(restored.snapshot()).toEqual(snapshot)
    expect(restored.blocked('abcd1234')).toMatchObject({ retryAt: 1_900_000 })
  })

  it('never takes back a wait longer than a day, nor odd strikes', () => {
    const now = 1_000_000
    const saved = {
      // Saved while the device's clock was a year ahead.
      ahead: {
        reason: 'quota-exceeded',
        since: now + 365 * DAY,
        retryAt: now + 365 * DAY,
        strikes: 3,
      },
      negative: { reason: 'quota-exceeded', since: now, retryAt: now + MINUTE, strikes: -3 },
      fraction: { reason: 'suspended', since: now, retryAt: now + MINUTE, strikes: 2.5 },
    } as unknown as JamendoQuotaSnapshot
    const { quota, clock } = quotaAt(now, saved)
    expect(quota.recorded('ahead')).toEqual({
      reason: 'quota-exceeded',
      since: now + DAY,
      retryAt: now + DAY,
      strikes: 3,
    })
    expect(quota.recorded('negative')).toMatchObject({ strikes: 1 })
    expect(quota.recorded('fraction')).toMatchObject({ strikes: 1 })
    clock.now += MINUTE
    quota.record('negative', 'quota-exceeded')
    expect(quota.recorded('negative')).toMatchObject({
      strikes: 2,
      retryAt: clock.now + 60 * MINUTE,
    })
  })
})
