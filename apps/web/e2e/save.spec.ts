import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { createFakeNetwork } from '../src/app/services/testing/fake-network'
import { FIXTURES, mp3Only, silentMp3, storedDownloads, stubNetwork } from './fake-services'

// Download and Save to device (stage 4.2) through the app's real composition (src/app/services),
// in a real browser: Download on a song from Internet Archive asks for the format (FLAC), then
// downloads it into the Origin Private File System and saves it as FLAC, which the conversion
// worker makes with FXM's ffmpeg core, served at the app's ffmpeg/ folder; then the downloaded
// song's "Save to device…" saves it again as WAV, from its copy. Only the network is fake
// (fake-services.ts): the song is a few silent MP3 frames the test makes, never a recording, and
// nothing reaches the internet.
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

test('downloads a song and saves it as FLAC, converted on the device by the ffmpeg core', async ({
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

  // Download the song from Internet Archive, as FLAC.
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
  const dialog = page.getByRole('dialog', { name: 'Download' })
  await dialog.getByRole('radio', { name: 'FLAC .flac' }).check()
  await expect(dialog).toContainText(
    'An MP3 from Internet Archive: FLAC (converted from MP3, same quality as the source).',
  )
  await expect(dialog).toContainText(
    'Lossy audio never becomes lossless: converting it gives a bigger file, not a better one.',
  )
  await expect(dialog).toContainText('Save to device converts with code of FFmpeg')
  const saved = page.waitForEvent('download', { timeout: 60_000 })
  await dialog.getByRole('button', { name: 'Download' }).click()
  const download = await saved
  await expect(page.getByText(`Saved “${title}” as ${download.suggestedFilename()}`)).toBeVisible()
  expect(download.suggestedFilename()).toMatch(/\.flac$/u)
  // The song is downloaded in FXM too, to play offline.
  expect(await storedDownloads(page)).toEqual([{ title, status: 'completed' }])

  // A FLAC file that the core encoded from the decoded MP3, with FXM's tags.
  const bytes = new Uint8Array(readFileSync(await download.path()))
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('fLaC')
  const info = streamInfo(bytes)
  expect(info.sampleRate).toBe(44_100)
  expect(info.samples).toBeGreaterThan(0)
  expect(new TextDecoder().decode(bytes)).toContain(`TITLE=${title}`)
  // The worker loaded the core: its manifest, script and WebAssembly.
  expect(coreRequests.some((url) => /ffmpeg-core\.wasm\?v=/u.test(url))).toBe(true)

  // Save it again, as WAV, from the Downloads playlist: from its copy, without the network.
  const archiveRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).hostname.endsWith('archive.org')) archiveRequests.push(request.url())
  })
  await page.goto('library?tab=downloads')
  const list = page.getByRole('list', { name: 'Songs in Downloads' })
  await list.getByRole('button', { name: `More options for ${title}` }).click()
  await page.getByRole('menuitem', { name: 'Save to device…' }).click()
  const again = page.getByRole('dialog', { name: 'Save to device' })
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  await expect(again).toHaveAccessibleDescription(
    new RegExp(`^“${escaped}” · downloaded as MP3`, 'u'),
  )
  await again
    .getByRole('radio', { name: 'WAV (converted from MP3, same quality as the source) .wav' })
    .check()
  await expect(again).toContainText('FXM converts it on this device, which takes a little while.')
  const savedAgain = page.waitForEvent('download', { timeout: 60_000 })
  await again.getByRole('button', { name: 'Save' }).click()
  const wav = await savedAgain
  expect(wav.suggestedFilename()).toMatch(/\.wav$/u)
  const riff = new Uint8Array(readFileSync(await wav.path()))
  expect(new TextDecoder().decode(riff.subarray(0, 4))).toBe('RIFF')
  expect(new TextDecoder().decode(riff.subarray(8, 12))).toBe('WAVE')
  // Its audio wasn't downloaded again: only the cover was fetched, for the file's tags.
  expect(archiveRequests.filter((url) => /\.(?:mp3|flac|ogg)(?:$|\?)/u.test(url))).toEqual([])
})
