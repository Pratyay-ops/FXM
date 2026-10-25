import { describe, expect, it, vi } from 'vitest'
import { JamendoQuota, type JamendoQuotaSnapshot } from './quota'

const MINUTE = 60_000

/** A quota on a clock the test moves. */
function quotaAt(start = 1_000_000) {
  const clock = { now: start }
  const quota = new JamendoQuota({ now: () => clock.now })
  return { quota, clock }
}

describe('JamendoQuota', () => {
  it('blocks a rate-limited client_id for 15 minutes, then lets one request through', () => {
    const { quota, clock } = quotaAt()
    expect(quota.blocked('abcd1234')).toBeUndefined()
    quota.record('abcd1234', 'rate-limited')
    const block = {
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
      quota.record('abcd1234', 'rate-limited')
      const block = quota.recorded('abcd1234')
      if (block?.reason !== 'quota-exceeded') throw new Error('expected a rate-limit block')
      waits.push((block.retryAt - clock.now) / MINUTE)
      expect(block.since).toBe(1_000_000)
      clock.now = block.retryAt
    }
    expect(waits).toEqual([15, 60, 240, 960, 1440, 1440])
  })

  it('lifts every block once a request succeeds', () => {
    const { quota } = quotaAt()
    quota.record('abcd1234', 'rate-limited')
    quota.record('abcd1234', 'ok')
    expect(quota.recorded('abcd1234')).toBeUndefined()
    quota.record('abcd1234', 'rate-limited')
    expect(quota.recorded('abcd1234')).toMatchObject({ strikes: 1 })
  })

  it('keeps an unknown or suspended client_id blocked until it works again', () => {
    const { quota, clock } = quotaAt()
    quota.record('badid000', 'invalid')
    quota.record('susp0000', 'suspended')
    clock.now += 365 * 24 * 60 * MINUTE
    expect(quota.blocked('badid000')).toEqual({ reason: 'invalid-client-id' })
    expect(quota.blocked('susp0000')).toEqual({ reason: 'suspended' })
    quota.record('badid000', 'rate-limited')
    expect(quota.recorded('badid000')).toMatchObject({ reason: 'quota-exceeded', strikes: 1 })
  })

  it('tells listeners when a block is recorded or lifted, and stops when asked', () => {
    const { quota } = quotaAt()
    const listener = vi.fn()
    const stop = quota.onChange(listener)
    quota.record('abcd1234', 'ok')
    expect(listener).not.toHaveBeenCalled()
    quota.record('abcd1234', 'rate-limited')
    quota.record('abcd1234', 'ok')
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    quota.record('abcd1234', 'invalid')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('saves its blocks and takes them back, dropping anything malformed', () => {
    const { quota } = quotaAt()
    quota.record('abcd1234', 'rate-limited')
    quota.record('badid000', 'invalid')
    const snapshot = quota.snapshot()
    expect(snapshot).toEqual({
      abcd1234: { reason: 'quota-exceeded', since: 1_000_000, retryAt: 1_900_000, strikes: 1 },
      badid000: { reason: 'invalid-client-id' },
    })
    const saved = {
      ...snapshot,
      broken1: { reason: 'quota-exceeded', since: 'yesterday' },
      broken2: null,
      broken3: { reason: 'banned' },
    } as unknown as JamendoQuotaSnapshot
    const restored = new JamendoQuota({ saved, now: () => 1_000_000 })
    expect(restored.snapshot()).toEqual(snapshot)
    expect(restored.blocked('abcd1234')).toMatchObject({ retryAt: 1_900_000 })
    snapshot.abcd1234 = { reason: 'suspended' }
    expect(restored.recorded('abcd1234')).toMatchObject({ reason: 'quota-exceeded' })
  })
})
