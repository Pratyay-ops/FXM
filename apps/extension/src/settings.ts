import { SPOTIFY_LOGIN_KEY } from './config.ts'
import type { StorageArea } from './webext.ts'

/** Whether "Use my Spotify login from this browser" is on. Anything but `true` means off. */
export async function readSpotifyLogin(storage: Pick<StorageArea, 'get'>): Promise<boolean> {
  const items = await storage.get(SPOTIFY_LOGIN_KEY)
  return items[SPOTIFY_LOGIN_KEY] === true
}

/** Saves the "Use my Spotify login from this browser" toggle. */
export async function writeSpotifyLogin(
  storage: Pick<StorageArea, 'set'>,
  enabled: boolean,
): Promise<void> {
  await storage.set({ [SPOTIFY_LOGIN_KEY]: enabled })
}
