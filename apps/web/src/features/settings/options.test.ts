import { afterEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_MODE_DESCRIPTIONS } from './options'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the catalog mode descriptions', () => {
  it('name Jamendo among the sources of Music only in a build that offers it', () => {
    expect(CATALOG_MODE_DESCRIPTIONS.music).toBe(
      'Music: songs only, from any source – YouTube Music’s album audio, free music from Internet Archive, and your own files.',
    )
    vi.stubEnv('VITE_FXM_JAMENDO_CLIENT_ID', 'public-id')
    expect(CATALOG_MODE_DESCRIPTIONS.music).toBe(
      'Music: songs only, from any source – YouTube Music’s album audio, free music from Internet Archive and Jamendo, and your own files.',
    )
  })
})
