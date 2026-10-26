/**
 * A fake of the Android app's `FxmDeviceMusic` plugin: the device's songs as MediaStore would
 * list them, in pages by id, with covers per album, behind the permission a test grants,
 * refuses or leaves for Android to ask about.
 *
 * @module
 */

import type {
  DeviceMusicAccess,
  FxmDeviceAlbum,
  FxmDeviceAudio,
  FxmDeviceMusicPlugin,
} from '../device-music'

/** The fake plugin, plus the songs and covers it lists and what it was asked. */
export interface FakeDeviceMusic extends FxmDeviceMusicPlugin {
  /** The device's songs, by MediaStore id. */
  songs: FxmDeviceAudio[]
  /** The covers it has, by `<volume>/<album id>`, as base64 JPEG data. */
  covers: Map<string, string>
  /** Whether FXM may read the music now. */
  access: DeviceMusicAccess
  /** What the user answers when asked: `granted`, or a refusal (`denied` is for good). */
  answer: DeviceMusicAccess
  /** How many times the user was asked. */
  asked: number
  /** How many times Android's settings were opened. */
  settingsOpened: number
  /** The albums whose covers were asked for, in order. */
  albumsAsked: FxmDeviceAlbum[]
  /** Makes `scan` wait until the returned function is called. */
  hold(): () => void
}

/** A song of `path` on the phone's own storage, MediaStore id `id`. */
export function deviceSong(
  id: number,
  path: string,
  extra: Partial<FxmDeviceAudio> = {},
): FxmDeviceAudio {
  return {
    id: String(id),
    uri: `content://media/external_primary/audio/media/${id}`,
    volume: 'external_primary',
    path,
    size: 4_000_000,
    modifiedMs: 1_700_000_000_000,
    mimeType: 'audio/mpeg',
    durationMs: 200_000,
    ...extra,
  }
}

/** Creates the fake plugin, with no songs and the permission not asked for yet. */
export function createFakeDeviceMusic(songs: FxmDeviceAudio[] = []): FakeDeviceMusic {
  const refuse = () => Object.assign(new Error('FXM may not read the music'), { code: 'DENIED' })
  let held: Promise<void> | undefined
  const fake: FakeDeviceMusic = {
    songs,
    covers: new Map(),
    access: 'prompt',
    answer: 'granted',
    asked: 0,
    settingsOpened: 0,
    albumsAsked: [],
    hold() {
      let release = () => {}
      held = new Promise<void>((resolve) => {
        release = () => {
          held = undefined
          resolve()
        }
      })
      return () => release()
    },
    async checkAccess() {
      return { music: fake.access }
    },
    async requestAccess() {
      if (fake.access !== 'granted' && fake.access !== 'denied') {
        fake.asked += 1
        fake.access = fake.answer
      }
      return { music: fake.access }
    },
    async openSettings() {
      fake.settingsOpened += 1
    },
    async scan({ after, limit }) {
      if (held !== undefined) await held
      if (fake.access !== 'granted') throw refuse()
      const sorted = [...fake.songs].sort((a, b) => Number(a.id) - Number(b.id))
      const start =
        after === undefined ? 0 : sorted.findIndex((song) => Number(song.id) > Number(after))
      const rest = start < 0 ? [] : sorted.slice(start)
      const items = rest.slice(0, limit)
      const next = rest.length > limit ? (items.at(-1)?.id ?? null) : null
      return after === undefined ? { items, next, total: sorted.length } : { items, next }
    },
    async artwork({ albums }) {
      if (fake.access !== 'granted') throw refuse()
      fake.albumsAsked.push(...albums)
      const pictures = albums.flatMap((album) => {
        const data = fake.covers.get(`${album.volume}/${album.id}`)
        return data === undefined
          ? []
          : [{ volume: album.volume, id: album.id, data, width: 4, height: 4 }]
      })
      return { pictures }
    },
  }
  return fake
}
