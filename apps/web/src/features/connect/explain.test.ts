import { describe, expect, it } from 'vitest'
import {
  describeConnect,
  describeLite,
  describeSpotify,
  describeYouTube,
  explainConnection,
} from './explain'
import { CONNECT_STATUS, readyConnection, TIER_CAPABILITIES } from './testing'

describe('explainConnection', () => {
  it('says it is still checking before detection is done', () => {
    expect(explainConnection(readyConnection({ phase: 'detecting' }))).toEqual([
      'Checking how FXM can reach music on this device…',
    ])
  })

  it('names FXM Connect and its version in Full', () => {
    const lines = explainConnection(
      readyConnection({
        connect: CONNECT_STATUS.present,
        capabilities: TIER_CAPABILITIES.full,
        lite: 'not-needed',
      }),
    )
    expect(lines).toEqual(['FXM Connect 0.1.0 is on in this browser.'])
  })

  it('explains Lite: no FXM Connect, and the check passed', () => {
    expect(
      explainConnection(readyConnection({ capabilities: TIER_CAPABILITIES.lite, lite: 'passed' })),
    ).toEqual([
      "FXM Connect isn't installed in this browser.",
      "Lite's check passed: YouTube Music answers this browser without an install.",
    ])
  })

  it('explains Free only: the check failed, or Lite is switched off', () => {
    expect(explainConnection(readyConnection({ lite: 'failed' }))[1]).toMatch(/didn't pass/)
    expect(explainConnection(readyConnection({ lite: 'switched-off' }))[1]).toMatch(
      /switched off for everyone/,
    )
  })

  it('says an outdated FXM Connect goes unused, and which version FXM needs', () => {
    expect(describeConnect(CONNECT_STATUS.outdated)).toBe(
      "FXM Connect 0.0.9 is too old for this version of FXM, so FXM doesn't use it. FXM needs version 0.1.0 or later.",
    )
  })

  it('says a missing FXM Connect worked before and may be off or blocked', () => {
    expect(describeConnect(CONNECT_STATUS.missing)).toBe(
      "FXM Connect worked in this browser before (version 0.1.0), but it isn't answering now. It may be turned off, removed or blocked by the browser.",
    )
  })

  it('mentions the Spotify login when FXM Connect offers it', () => {
    const lines = explainConnection(
      readyConnection({
        connect: { ...CONNECT_STATUS.present, features: ['youtube', 'spotify', 'spotify-login'] },
        capabilities: { ...TIER_CAPABILITIES.full, spotify: 'account' },
        lite: 'not-needed',
      }),
    )
    expect(lines).toContain('FXM Connect lets FXM use your Spotify login from this browser.')
  })

  it('speaks of the app on desktop and Android', () => {
    expect(
      explainConnection(
        readyConnection({ platform: 'desktop', capabilities: TIER_CAPABILITIES.full }),
      ),
    ).toEqual(['The desktop app reaches every service directly, with nothing else to install.'])
    expect(explainConnection(readyConnection({ platform: 'android' }))).toEqual([
      "This version of the Android app can't reach YouTube Music or Spotify yet.",
    ])
  })

  it('admits a failed detection', () => {
    expect(explainConnection(readyConnection({ phase: 'failed' }))[0]).toMatch(/couldn't check/)
  })
})

describe('the short descriptions', () => {
  it('describe each Lite state, and nothing when Lite is not needed', () => {
    expect(describeLite('not-needed')).toBeUndefined()
    expect(describeLite('checking')).toMatch(/Checking/)
    expect(describeLite('unavailable')).toMatch(/isn't available/)
  })

  it('describe what YouTube and Spotify allow', () => {
    expect(describeYouTube(TIER_CAPABILITIES.lite)).toMatch(/through Lite/)
    expect(describeYouTube(TIER_CAPABILITIES.free)).toBe('Not reachable')
    expect(describeSpotify(TIER_CAPABILITIES.full)).toBe('Reachable')
    expect(describeSpotify(TIER_CAPABILITIES.lite)).toBe('Not reachable')
  })
})
