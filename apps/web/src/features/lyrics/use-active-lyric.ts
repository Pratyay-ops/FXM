import { type Lyrics, lineAt, wordAt } from '@fxm/core'
import { useEffect, useState } from 'react'
import { usePlayerState } from '../now-playing/playback'

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
 * change on time. It renders only when the line or the word changes.
 */
export function useActiveLyric(lyrics: Lyrics): ActiveLyric {
  const positionMs = usePlayerState((state) => state.positionMs)
  const running = usePlayerState((state) => state.status === 'playing' && !state.buffering)
  const [active, setActive] = useState(() => activeLyricAt(lyrics, positionMs))

  useEffect(() => {
    const show = (at: number) => {
      const next = activeLyricAt(lyrics, at)
      setActive((shown) => (shown.line === next.line && shown.word === next.word ? shown : next))
    }
    show(positionMs)
    if (!running) return
    // The position just reported is the position now; from here the clock runs with the audio.
    const reportedAt = performance.now()
    let frame = requestAnimationFrame(function tick() {
      show(positionMs + performance.now() - reportedAt)
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [lyrics, positionMs, running])

  return active
}
