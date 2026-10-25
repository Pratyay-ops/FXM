import { describe, expect, it } from 'vitest'
import { readSpotifyLogin, writeSpotifyLogin } from './settings.ts'

function storage(initial: Record<string, unknown> = {}) {
  const data = { ...initial }
  return {
    data,
    get: async (key: string | string[]) =>
      typeof key === 'string' && key in data ? { [key]: data[key] } : {},
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items)
    },
  }
}

describe('Spotify login setting', () => {
  it('is off by default and for anything but true', async () => {
    expect(await readSpotifyLogin(storage())).toBe(false)
    for (const value of ['true', 1, {}, null]) {
      expect(await readSpotifyLogin(storage({ spotifyLogin: value }))).toBe(false)
    }
  })

  it('round-trips through storage.local', async () => {
    const area = storage()
    await writeSpotifyLogin(area, true)
    expect(area.data).toEqual({ spotifyLogin: true })
    expect(await readSpotifyLogin(area)).toBe(true)
    await writeSpotifyLogin(area, false)
    expect(await readSpotifyLogin(area)).toBe(false)
  })
})
