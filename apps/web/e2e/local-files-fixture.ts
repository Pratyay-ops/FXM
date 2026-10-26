import type { Page } from '@playwright/test'
import {
  flacFile,
  mp3File,
  pngImage,
  wavFile,
} from '../src/features/local-files/testing/audio-files'

// Local files in a real browser: the folder picker is stubbed with a folder of the
// origin-private file system, a real FileSystemDirectoryHandle, filled with tiny generated
// files of silence. So music-metadata's browser build, the cover thumbnails (canvas), the
// handle kept in IndexedDB and playback from object URLs all run for real.

const COVER = { data: pngImage([40, 90, 200], 64), mime: 'image/png' }

/** A FLAC with a cover, an MP3 and a WAV, in folders like a real music library. */
export const FILES: { path: string; bytes: Uint8Array }[] = [
  {
    path: 'Aria Vale/Neon Rivers/01 Night Drive.flac',
    bytes: flacFile({
      tags: { title: 'Night Drive', artists: ['Aria Vale'], album: 'Neon Rivers', track: 1 },
      picture: COVER,
      frames: 40,
    }),
  },
  {
    path: 'Aria Vale/Neon Rivers/02 Slow Tide.mp3',
    bytes: mp3File({
      tags: { title: 'Slow Tide', artists: ['Aria Vale'], album: 'Neon Rivers', track: 2 },
      frames: 160,
    }),
  },
  {
    path: 'Field Kit/Room Tone.wav',
    bytes: wavFile({ tags: { title: 'Room Tone', artists: ['Field Kit'] }, seconds: 4 }),
  },
]

/** Makes the folder picker hand out the origin-private `Music` folder, as if the user chose it. */
export async function stubFolderPicker(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, {
      showDirectoryPicker: async () =>
        (await navigator.storage.getDirectory()).getDirectoryHandle('Music'),
    })
  })
}

/** Writes {@link FILES} into a `Music` folder of the origin-private file system. */
export async function fillMusicFolder(page: Page) {
  await page.goto('./')
  await page.evaluate(
    async (files) => {
      const root = await navigator.storage.getDirectory()
      const music = await root.getDirectoryHandle('Music', { create: true })
      for (const { path, bytes } of files) {
        const parts = path.split('/')
        const name = parts.pop() ?? path
        let dir = music
        for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true })
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable()
        await writable.write(new Uint8Array(bytes))
        await writable.close()
      }
    },
    FILES.map(({ path, bytes }) => ({ path, bytes: Array.from(bytes) })),
  )
}

/** The Library's list of local songs. */
export function songs(page: Page) {
  return page.getByRole('list', { name: 'Songs in local files' })
}
