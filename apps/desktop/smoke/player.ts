/**
 * Plays a URL to its end in an `<audio>` element, muted, as the smoke test's media player.
 *
 * @module
 */

import type { MediaPlayer } from './steps'

/** How long playback may stand still before it counts as stalled. */
export const STALL_MS = 30_000

/** The media player of the page. Muted: the test runs unattended, often at night. */
export function htmlAudioPlayer(stallMs = STALL_MS): MediaPlayer {
  return {
    playToEnd(url, { timeoutMs }) {
      return new Promise((resolve, reject) => {
        const audio = new Audio()
        audio.muted = true
        audio.preload = 'auto'
        let lastTime = -1
        let lastMove = Date.now()
        const state = () =>
          `at ${audio.currentTime.toFixed(1)} s of ${audio.duration.toFixed(1)} s, ` +
          `readyState ${audio.readyState}, networkState ${audio.networkState}`
        const finish = (error?: Error) => {
          clearTimeout(deadline)
          clearInterval(watch)
          const durationS = audio.duration
          audio.removeAttribute('src')
          audio.load()
          if (error) reject(error)
          else resolve({ durationS })
        }
        const deadline = setTimeout(() => {
          finish(new Error(`still playing after ${timeoutMs} ms, ${state()}`))
        }, timeoutMs)
        const watch = setInterval(() => {
          if (audio.currentTime !== lastTime) {
            lastTime = audio.currentTime
            lastMove = Date.now()
          } else if (Date.now() - lastMove > stallMs) {
            finish(new Error(`stalled for ${stallMs / 1000} s, ${state()}`))
          }
        }, 1_000)
        audio.addEventListener('ended', () => finish())
        audio.addEventListener('error', () => {
          finish(new Error(`media error ${audio.error?.code}: ${audio.error?.message ?? ''}`))
        })
        audio.src = url
        audio.play().catch((error: unknown) => {
          finish(new Error(`play() refused: ${String(error)}, ${state()}`))
        })
      })
    },
  }
}
