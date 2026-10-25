import { describe, expect, it } from 'vitest'
import { fxmOrigins } from './config.ts'
import {
  isLocalhost,
  originHost,
  originMatchPattern,
  parseOrigin,
  rulesetId,
  rulesetSwitch,
  sharesHost,
} from './origins.ts'

const FXM = 'https://fxm-music.pages.dev'
const DEV = fxmOrigins(true)

describe('parseOrigin', () => {
  it('accepts HTTPS origins and http://localhost', () => {
    expect(parseOrigin(FXM).hostname).toBe('fxm-music.pages.dev')
    expect(parseOrigin('http://localhost:5173').port).toBe('5173')
  })

  it.each([
    'http://fxm-music.pages.dev',
    'https://fxm-music.pages.dev/',
    'https://fxm-music.pages.dev/app/',
    'HTTPS://FXM-MUSIC.PAGES.DEV',
    'fxm-music.pages.dev',
    'ftp://localhost',
    '',
  ])('rejects %j', (origin) => {
    expect(() => parseOrigin(origin)).toThrow()
  })
})

describe('origin helpers', () => {
  it('derives hosts, match patterns and ruleset IDs', () => {
    expect(originHost(FXM)).toBe('fxm-music.pages.dev')
    expect(originHost('http://localhost:4173')).toBe('localhost')
    expect(originMatchPattern(FXM)).toBe('https://fxm-music.pages.dev/*')
    expect(originMatchPattern('http://localhost:4173')).toBe('http://localhost/*')
    expect(rulesetId(FXM)).toBe('fxm_music_pages_dev')
    expect(rulesetId('http://localhost:4173')).toBe('localhost_4173')
  })

  it('recognizes the localhost origins of the dev build', () => {
    expect(isLocalhost('http://localhost:5173')).toBe(true)
    expect(isLocalhost(FXM)).toBe(false)
  })

  it('detects origins that share a host', () => {
    expect(sharesHost(FXM, DEV)).toBe(false)
    expect(sharesHost('http://localhost:5173', DEV)).toBe(true)
    expect(sharesHost('http://localhost:5173', fxmOrigins(false))).toBe(false)
  })
})

describe('rulesetSwitch', () => {
  it('never switches in the production build', () => {
    expect(rulesetSwitch(FXM, fxmOrigins(false))).toBeNull()
  })

  it('switches between the localhost rulesets of the dev build', () => {
    expect(rulesetSwitch('http://localhost:4173', DEV)).toEqual({
      enableRulesetIds: ['localhost_4173'],
      disableRulesetIds: ['localhost_5173'],
    })
    expect(rulesetSwitch('http://localhost:5173', DEV)).toEqual({
      enableRulesetIds: ['localhost_5173'],
      disableRulesetIds: ['localhost_4173'],
    })
    expect(rulesetSwitch(FXM, DEV)).toBeNull()
  })

  it('ignores origins that are not allowed', () => {
    expect(rulesetSwitch('http://localhost:3000', DEV)).toBeNull()
  })
})
