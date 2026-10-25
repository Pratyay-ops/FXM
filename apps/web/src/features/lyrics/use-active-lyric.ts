import { type Lyrics, lineAt, wordAt } from '@fxm/core'
import { useEffect, useState } from 'react'
import { usePlayer, usePlayerState } from '../now-playing/playback'

/** The line, and the word within it, sung at a moment; -1 for none. */
export interface ActiveLyric {
  line: number
  word: number
}

/** The line and word of `lyrics` sung at `positionMs`. */
export function activeLyricAt(lyrics: Lyrics, positionMs: number): ActiveLyric {
  const line = lineAt(lyrics, positionMs)
  const current = lyrics.lines[line]
  return { line, word: current === undefined ? -1 : wordAt(current, positionMs) }
}

/**
 * The line and word of synced `lyrics` sung now. The player reports the position a few times a
 * second; while audio plays, this moves it on between reports every animation frame, so lines
 * change on time. The position stays out of React state: the component renders only when the
 * line or the word changes, or playback starts or stops.
 */
export function useActiveLyric(lyrics: Lyrics): ActiveLyric {
  const player = usePlayer()
  const running = usePlayerState((state) => state.status === 'playing' && !state.buffering)
  const [active, setActive] = useState(() => activeLyricAt(lyrics, player.getState().positionMs))

  useEffect(() => {
    const show = (at: number) => {
      const next = activeLyricAt(lyrics, at)
      setActive((shown) => (shown.line === next.line && shown.word === next.word ? shown : next))
    }
    // The position last reported, and when: from there the clock runs with the audio.
    let reported = player.getState().positionMs
    let reportedAt = performance.now()
    show(reported)
    const stop = player.subscribe((state) => {
      if (state.positionMs === reported) return
      reported = state.positionMs
      reportedAt = performance.now()
      show(reported)
    })
    if (!running) return stop
    let frame = requestAnimationFrame(function tick() {
      show(reported + performance.now() - reportedAt)
      frame = requestAnimationFrame(tick)
    })
    return () => {
      stop()
      cancelAnimationFrame(frame)
    }
  }, [lyrics, player, running])

  return active
}
