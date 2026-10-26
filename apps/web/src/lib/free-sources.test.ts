import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildJamendoClientId, freeSources, jamendoOffered } from './free-sources'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the free sources', () => {
  it('leave Jamendo out of a build without its client_id', () => {
    vi.stubEnv('VITE_FXM_JAMENDO_CLIENT_ID', '')
    expect(buildJamendoClientId()).toBeUndefined()
    expect(jamendoOffered()).toBe(false)
    expect(freeSources()).toEqual({
      and: 'Internet Archive',
      or: 'Internet Archive',
      several: false,
    })
  })

  it('name Jamendo in a build that has one', () => {
    vi.stubEnv('VITE_FXM_JAMENDO_CLIENT_ID', ' public-id ')
    expect(buildJamendoClientId()).toBe('public-id')
    expect(freeSources()).toEqual({
      and: 'Internet Archive and Jamendo',
      or: 'Internet Archive or Jamendo',
      several: true,
    })
  })

  it('take the choice when given', () => {
    expect(freeSources(true).and).toBe('Internet Archive and Jamendo')
    expect(freeSources(false).or).toBe('Internet Archive')
  })
})
