import { expect, type Page, test } from '@playwright/test'
import { createFakeNetwork, wavTone } from '../src/app/services/testing/fake-network'
import { FIXTURES, installFakeConnect, startRedirectTarget, stubNetwork } from './fake-services'

// The equalizer on YouTube audio in a real browser, through the app's real composition: FXM
// Connect (faked: the marker and the ping) makes googlevideo's bytes readable, so the player moves
// the song onto an <audio crossorigin> element routed through Web Audio. The fake network stands
// in for FXM Connect's header rules: googlevideo's answers carry Access-Control-Allow-Origin.
// Nothing reaches the internet, and Chromium runs muted.

/** What the page's init script records, read with `page.evaluate`. */
interface EqualizerRecord {
  /** Every media element the page played. */
  fxmMedia: Set<HTMLMediaElement>
  /** How many media elements were connected to Web Audio. */
  fxmSources: number
}

/** Records the media elements the player plays and the ones it connects to Web Audio. */
async function watchAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record = window as unknown as EqualizerRecord
    record.fxmMedia = new Set()
    record.fxmSources = 0
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      record.fxmMedia.add(this)
      return play.call(this)
    }
    const connect = AudioContext.prototype.createMediaElementSource
    AudioContext.prototype.createMediaElementSource = function (
      this: AudioContext,
      element: HTMLMediaElement,
    ) {
      record.fxmSources += 1
      return connect.call(this, element)
    }
  })
}

/** Turns the equalizer on with the Bass boost preset before the app starts. */
async function bassBoost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const equalizer = {
      enabled: true,
      gainsDb: [6, 5, 4, 2, 0.5, 0, 0, 0, 0, 0],
      preset: 'bass-boost',
    }
    localStorage.setItem(
      'fxm.audio-effects.v1',
      JSON.stringify({ state: { effects: { equalizer } }, version: 1 }),
    )
  })
}

/** The element that plays (past its start, not paused): its host and `crossOrigin`. */
function playing(page: Page) {
  return page.evaluate(() => {
    const record = window as unknown as EqualizerRecord
    const element = [...record.fxmMedia].find((media) => !media.paused && media.currentTime > 0)
    return element === undefined
      ? null
      : { host: new URL(element.currentSrc).hostname, crossOrigin: element.crossOrigin }
  })
}

/** Plays the first song of a YouTube Music search. */
async function playFirstSong(page: Page): Promise<void> {
  await page.goto('search?q=radiohead%20creep')
  const songs = page.getByRole('list', { name: 'Songs' })
  await songs
    .getByRole('button', { name: /^Play / })
    .first()
    .click()
}

/** What the Sound dialog says about the equalizer. */
async function equalizerLines(page: Page): Promise<string[]> {
  await page
    .getByRole('region', { name: 'Player' })
    .getByRole('button', { name: /^Sound/ })
    .click()
  const text = await page.getByRole('dialog').innerText()
  return text.split('\n').filter((line) => /not available|FXM Connect/i.test(line))
}

test('the equalizer processes a YouTube song through Web Audio with FXM Connect', async ({
  page,
}) => {
  const network = createFakeNetwork({ fixtures: FIXTURES, audio: wavTone(20) })
  await stubNetwork(page, network)
  await watchAudio(page)
  await bassBoost(page)
  await installFakeConnect(page)

  await playFirstSong(page)

  // The song plays from googlevideo on an <audio crossorigin> connected to Web Audio.
  await expect
    .poll(() => playing(page), { timeout: 10_000 })
    .toEqual({ host: 'rr1---sn-fxmfixture.googlevideo.com', crossOrigin: 'anonymous' })
  expect(
    await page.evaluate(() => (window as unknown as EqualizerRecord).fxmSources),
  ).toBeGreaterThan(0)
  // And the Sound dialog has nothing to explain.
  expect(await equalizerLines(page)).toEqual([])
})

test('a song googlevideo moves to another server plays without the equalizer, which says why', async ({
  page,
}) => {
  // googlevideo's cms_redirect, with FXM Connect 0.2.0's exact Access-Control-Allow-Origin: after
  // the redirect the browser sends Origin: null, so the <audio crossorigin> fails while a plain
  // <audio> follows the redirect and plays. The fake FXM Connect is 0.1.0.
  const appOrigin = new URL(test.info().project.use.baseURL ?? 'http://localhost/').origin
  const audio = wavTone(20)
  const target = await startRedirectTarget(audio, appOrigin)
  try {
    const network = createFakeNetwork({
      fixtures: FIXTURES,
      audio,
      googlevideo: 'redirected',
      googlevideoAllowOrigin: appOrigin,
      googlevideoRedirectTo: target.origin,
    })
    await stubNetwork(page, network)
    await watchAudio(page)
    await bassBoost(page)
    await installFakeConnect(page)

    await playFirstSong(page)

    // A media element keeps the URL it was given; the bytes came from the other host.
    await expect
      .poll(() => playing(page), { timeout: 10_000 })
      .toEqual({ host: 'rr1---sn-fxmfixture.googlevideo.com', crossOrigin: null })
    expect(target.requests()).toBeGreaterThan(0)
    expect(await equalizerLines(page)).toEqual([
      'Not available for this track: FXM Connect 0.1.0 couldn’t read its audio, which happens when YouTube moves a song to another server. Update FXM Connect to 0.2.1.',
    ])
  } finally {
    await target.close()
  }
})
