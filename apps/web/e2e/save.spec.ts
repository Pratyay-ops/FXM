import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import {
  createFakeNetwork,
  type FakeNetworkFixtures,
} from '../src/app/services/testing/fake-network'
import { FIXTURES, stubNetwork } from './fake-services'

// Save to device (stage 4.2) through the app's real composition (src/app/services), in a real
// browser: a song downloads from Internet Archive into the Origin Private File System, and its
// menu saves it as FLAC, which the conversion worker makes with FXM's ffmpeg core, served at the
// app's ffmpeg/ folder. Only the network is fake (fake-services.ts): the song is a few silent MP3
// frames the test makes, never a recording, and nothing reaches the internet.
//
// It needs a built core: `vite preview` serves the one `make ffmpeg-wasm` built
// (tools/ffmpeg-wasm/dev-server.ts), and without one the test is skipped. The check behind the
// site's `AVAILABLE.conversions` runs it on what Cloudflare Pages serves, under its real headers
// ('wasm-unsafe-eval', workers from the app's own origin only):
//
//   make ffmpeg-wasm && make dist
//   FXM_PREVIEW_PORT=5800 scripts/run.sh pnpm --filter @fxm/deploy preview   # in another terminal
//   FXM_E2E_BASE_URL=http://127.0.0.1:5800/app/ \
//     scripts/run.sh pnpm --filter @fxm/web exec playwright test save

/** The Internet Archive item without its FLAC and Ogg files: the download is then an MP3. */
function mp3Only(fixtures: FakeNetworkFixtures): FakeNetworkFixtures {
  const item = structuredClone(fixtures.archiveItems.nineinchnails_ghosts_I_IV) as {
    files?: { name?: string }[]
  }
  item.files = (item.files ?? []).filter((file) => !/\.(?:flac|ogg|zip)$/u.test(file.name ?? ''))
  return { ...fixtures, archiveItems: { nineinchnails_ghosts_I_IV: item } }
}

/**
 * Silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz, stereo): zero side information decodes as
 * silence in any decoder, so the core really decodes and encodes them.
 */
function silentMp3(frames = 40): Uint8Array {
  const FRAME_BYTES = 417
  const bytes = new Uint8Array(frames * FRAME_BYTES)
  for (let frame = 0; frame < frames; frame++) {
    bytes.set([0xff, 0xfb, 0x90, 0x00], frame * FRAME_BYTES)
  }
  return bytes
}

/** Where each download stands, from the `fxm-downloads` database: its song and status. */
function downloads(page: Page): Promise<{ title: string; status: string }[]> {
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
              })),
            )
          }
        }
      }),
  )
}

/** A FLAC file's STREAMINFO: its sample rate and how many samples it holds. */
function streamInfo(bytes: Uint8Array): { sampleRate: number; samples: number } {
  // "fLaC", then the first metadata block's header (4 bytes), which is STREAMINFO's.
  const info = bytes.subarray(8, 8 + 34)
  const sampleRate = (info[10] ?? 0) * 4096 + (info[11] ?? 0) * 16 + ((info[12] ?? 0) >> 4)
  const samples =
    ((info[13] ?? 0) & 0x0f) * 2 ** 32 +
    (((info[14] ?? 0) << 24) >>> 0) +
    ((info[15] ?? 0) << 16) +
    ((info[16] ?? 0) << 8) +
    (info[17] ?? 0)
  return { sampleRate, samples }
}

test('saves a downloaded song as FLAC, converted on the device by the ffmpeg core', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const core = await page.request.get('ffmpeg/ffmpeg-core.json')
  test.skip(!core.ok(), 'no ffmpeg core is served here: build one with make ffmpeg-wasm')

  const network = createFakeNetwork({ fixtures: mp3Only(FIXTURES), audio: silentMp3() })
  await stubNetwork(page, network)
  // No Lite: the Free tier, whatever serves the sandbox documents.
  await page.route('**/sandbox/**', (route) => route.abort('connectionrefused'))
  // The browser's downloads, as where the browser has no save picker: Playwright receives them.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true })
  })
  // What the conversion worker loads: the core's manifest, script and WebAssembly.
  const coreRequests: string[] = []
  page.context().on('request', (request) => {
    if (/\/ffmpeg\/ffmpeg-core\./u.test(request.url())) coreRequests.push(request.url())
  })

  // Download the song from Internet Archive.
  await page.goto('search?q=nine%20inch%20nails%20ghosts')
  await page.getByRole('button', { name: 'Search Internet Archive instead' }).click()
  const more = page
    .getByRole('list', { name: 'Songs' })
    .getByRole('button', { name: /^More options for / })
    .first()
  await expect(more).toBeVisible({ timeout: 15_000 })
  const title = ((await more.getAttribute('aria-label')) ?? '').replace('More options for ', '')
  await more.click()
  await page.getByRole('menuitem', { name: 'Download' }).click()
  await expect
    .poll(() => downloads(page), { timeout: 30_000 })
    .toEqual([{ title, status: 'completed' }])
  // Downloading needs no core.
  expect(coreRequests).toEqual([])

  // Save it as FLAC from the Downloads playlist.
  await page.goto('library?tab=downloads')
  const list = page.getByRole('list', { name: 'Songs in Downloads' })
  await list.getByRole('button', { name: `More options for ${title}` }).click()
  await page.getByRole('menuitem', { name: 'Save to device…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Save to device' })
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  await expect(dialog).toHaveAccessibleDescription(
    new RegExp(`^“${escaped}” · downloaded as MP3`, 'u'),
  )
  const flac = dialog.getByRole('radio', {
    name: 'FLAC (converted from MP3, same quality as the source) .flac',
  })
  await flac.check()
  await expect(dialog).toContainText('FXM converts it on this device, which takes a little while.')
  await expect(dialog).toContainText('Save to device converts with code of FFmpeg')
  const saved = page.waitForEvent('download', { timeout: 60_000 })
  await dialog.getByRole('button', { name: 'Save' }).click()
  const download = await saved
  await expect(page.getByText(`Saved “${title}” as ${download.suggestedFilename()}`)).toBeVisible()
  expect(download.suggestedFilename()).toMatch(/\.flac$/u)

  // A FLAC file that the core encoded from the decoded MP3, with FXM's tags.
  const bytes = new Uint8Array(readFileSync(await download.path()))
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('fLaC')
  const info = streamInfo(bytes)
  expect(info.sampleRate).toBe(44_100)
  expect(info.samples).toBeGreaterThan(0)
  expect(new TextDecoder().decode(bytes)).toContain(`TITLE=${title}`)
  // The worker loaded the core: its manifest, script and WebAssembly.
  expect(coreRequests.some((url) => /ffmpeg-core\.wasm\?v=/u.test(url))).toBe(true)
})
