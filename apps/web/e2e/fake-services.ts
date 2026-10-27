import { readFileSync } from 'node:fs'
import { type Page, type Request, test } from '@playwright/test'
import type { FakeNetwork, FakeNetworkFixtures } from '../src/app/services/testing/fake-network'

// What the browser tests of the app's real composition (src/app/services) share: the providers'
// recorded fixtures, a network stub that answers every request leaving the app's origin from the
// fake network (src/app/services/testing/fake-network.ts), and a fake FXM Connect. Nothing
// reaches the internet.

/** A provider fixture, read from its package (`packages/sources/src/…`). */
export function fixture(path: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../packages/sources/src/${path}`, import.meta.url), 'utf8'),
  )
}

/** The recorded answers: a songs search, a VISIONOS `/player`, an Internet Archive search and item. */
export const FIXTURES: FakeNetworkFixtures = {
  songs: fixture('youtube/fixtures/search-songs.json'),
  player: fixture('youtube/stream/fixtures/visionos-song.json'),
  archiveSearch: fixture('archive/fixtures/search-nin-ghosts.json'),
  archiveItems: { nineinchnails_ghosts_I_IV: fixture('archive/fixtures/item-nin-ghosts.json') },
}

/** The Internet Archive item without its FLAC and Ogg files: its downloads are then MP3s. */
export function mp3Only(fixtures: FakeNetworkFixtures): FakeNetworkFixtures {
  const item = structuredClone(fixtures.archiveItems.nineinchnails_ghosts_I_IV) as {
    files?: { name?: string }[]
  }
  item.files = (item.files ?? []).filter((file) => !/\.(?:flac|ogg|zip)$/u.test(file.name ?? ''))
  return { ...fixtures, archiveItems: { nineinchnails_ghosts_I_IV: item } }
}

/**
 * Silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz, stereo): zero side information decodes as
 * silence in any decoder, so the ffmpeg core really decodes and encodes them.
 */
export function silentMp3(frames = 40): Uint8Array {
  const FRAME_BYTES = 417
  const bytes = new Uint8Array(frames * FRAME_BYTES)
  for (let frame = 0; frame < frames; frame++) {
    bytes.set([0xff, 0xfb, 0x90, 0x00], frame * FRAME_BYTES)
  }
  return bytes
}

/** Where each download stands, from the `fxm-downloads` database: its song and status. */
export function storedDownloads(
  page: Page,
): Promise<{ title: string; status: string; error?: string }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('fxm-downloads')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('downloads')) {
            db.close()
            resolve([])
            return
          }
          const read = db.transaction('downloads', 'readonly').objectStore('downloads').getAll()
          read.onerror = () => reject(read.error)
          read.onsuccess = () => {
            db.close()
            resolve(
              (read.result as Record<string, unknown>[]).map((record) => ({
                title: String((record.track as { title?: unknown } | undefined)?.title),
                status: String(record.status),
                ...(record.error === undefined
                  ? {}
                  : { error: String((record.error as { code?: unknown }).code) }),
              })),
            )
          }
        }
      }),
  )
}

/** A file the fake pickers of {@link installFakePickers} received: its size and first bytes. */
export interface PickedFile {
  readonly size: number
  readonly head: number[]
}

/** What {@link installFakePickers} records on the page, read with `page.evaluate`. */
export interface PickerRecord {
  /** The files written, by name. */
  fxmFiles: Record<string, PickedFile>
  /** What the save picker and the folder picker were asked, in order. */
  fxmPicks: { picker: 'save' | 'folder'; options: unknown; downloads: number }[]
}

/**
 * Gives the page the File System Access API's save and folder pickers, as Chromium on desktop
 * has them, without their windows: the save picker "picks" the suggested name, the folder picker
 * a folder called Music, and what FXM writes stays in memory on the page (`PickerRecord`). Each
 * pick records how many downloads existed at that moment, so a test can tell that FXM asked
 * before it downloaded anything.
 */
export async function installFakePickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record = window as unknown as PickerRecord
    record.fxmFiles = {}
    record.fxmPicks = []
    const files = record.fxmFiles
    const countDownloads = () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('fxm-downloads')
        open.onerror = () => resolve(-1)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('downloads')) {
            db.close()
            resolve(0)
            return
          }
          const count = db.transaction('downloads', 'readonly').objectStore('downloads').count()
          count.onsuccess = () => {
            db.close()
            resolve(count.result)
          }
          count.onerror = () => resolve(-1)
        }
      })
    const handle = (name: string) => ({
      name,
      getFile: async () => ({ size: files[name]?.size ?? 0 }),
      remove: async () => {
        delete files[name]
      },
      createWritable: async () => ({
        write: async (blob: Blob) => {
          const bytes = new Uint8Array(await blob.arrayBuffer())
          files[name] = { size: bytes.length, head: Array.from(bytes.subarray(0, 4)) }
        },
        close: async () => {},
        abort: async () => {},
      }),
    })
    Object.assign(window, {
      showSaveFilePicker: async (options: { suggestedName: string }) => {
        record.fxmPicks.push({ picker: 'save', options, downloads: await countDownloads() })
        files[options.suggestedName] = { size: 0, head: [] }
        return handle(options.suggestedName)
      },
      showDirectoryPicker: async (options: unknown) => {
        record.fxmPicks.push({ picker: 'folder', options, downloads: await countDownloads() })
        return {
          name: 'Music',
          getFileHandle: async (name: string, open: { create?: boolean } = {}) => {
            if (!(name in files)) {
              if (!open.create) throw new DOMException(`${name} not found`, 'NotFoundError')
              files[name] = { size: 0, head: [] }
            }
            return handle(name)
          },
          removeEntry: async (name: string) => {
            delete files[name]
          },
        }
      },
    })
  })
}

/** Options for {@link stubNetwork}. */
export interface StubOptions {
  /**
   * Requests left unanswered, like a connection that stalls: a test that needs a download to
   * stay where it is holds its transfer.
   */
  readonly hold?: (request: Request) => boolean
  /** How long to wait before answering a request, in milliseconds: a slow host. Default: none. */
  readonly delay?: (request: Request) => number
}

/** Answers every request that leaves the app's own origin from `network`. */
export async function stubNetwork(
  page: Page,
  network: FakeNetwork,
  { hold, delay }: StubOptions = {},
): Promise<void> {
  const app = new URL(test.info().project.use.baseURL ?? 'http://localhost/')
  await page.route(
    (url) => url.origin !== app.origin,
    async (route) => {
      const request = route.request()
      if (hold?.(request) === true) return
      const wait = delay?.(request) ?? 0
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      const body = request.postData()
      let response: Response
      try {
        response = network.respond({
          method: request.method(),
          url: request.url(),
          headers: request.headers(),
          ...(body === null ? {} : { body }),
        })
      } catch {
        await route.abort('connectionrefused')
        return
      }
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      })
    },
  )
}

/** What {@link installFakeConnect} records on the page, read with `page.evaluate`. */
export interface ConnectRecord {
  /** When the fake FXM Connect answered the ping first, as `performance.now()`. */
  fxmPongAt?: number
}

/**
 * Makes the page find FXM Connect, as its content script does: the marker on `<html>` and an
 * answer to the ping (the protocol of apps/extension/src/messages.ts), `pongDelayMs` after it,
 * like a service worker waking up. The network stub stands in for the extension's header rules.
 */
export async function installFakeConnect(page: Page, { pongDelayMs = 0 } = {}): Promise<void> {
  await page.addInitScript((delayMs: number) => {
    const record = window as unknown as ConnectRecord
    const mark = () => document.documentElement?.setAttribute('data-fxm-connect', '0.1.0')
    // The content script runs at document_start, when <html> exists. Playwright runs init
    // scripts a moment earlier, so mark <html> as soon as the parser creates it, before any of
    // the page's scripts run.
    if (document.documentElement) mark()
    else {
      new MutationObserver((_, observer) => {
        if (!document.documentElement) return
        mark()
        observer.disconnect()
      }).observe(document, { childList: true })
    }
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return
      if (event.data?.type !== 'fxm-connect:ping') return
      setTimeout(() => {
        record.fxmPongAt ??= performance.now()
        window.postMessage(
          {
            type: 'fxm-connect:pong',
            version: '0.1.0',
            features: ['youtube', 'googlevideo', 'spotify', 'lastfm', 'spotify-server-time'],
          },
          window.location.origin,
        )
      }, delayMs)
    })
  }, pongDelayMs)
}
