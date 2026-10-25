import { describe, expect, expectTypeOf, it } from 'vitest'
import * as core from '../index'
import type { LyricsMetadata, LyricWord } from '../providers'

describe('the lyrics module', () => {
  it('is re-exported from the @fxm/core entry point', () => {
    for (const name of ['parseLrc', 'serializeLrc', 'lineAt', 'wordAt']) {
      expect(core).toHaveProperty(name)
    }
  })

  it('reads LRC through the entry point', () => {
    const lyrics = core.parseLrc('[ti:Song]\n[00:01.00]<00:01.00>Hi<00:01.50>', 'lrclib')
    expect(core.lineAt(lyrics, 1_200)).toBe(0)
    expect(lyrics.metadata).toEqual({ title: 'Song' })
    expectTypeOf(lyrics.metadata).toEqualTypeOf<LyricsMetadata | undefined>()
    expectTypeOf(lyrics.lines[0]?.words).toEqualTypeOf<LyricWord[] | undefined>()
  })
})
