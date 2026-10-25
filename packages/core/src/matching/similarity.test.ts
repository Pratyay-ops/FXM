import { describe, expect, it } from 'vitest'
import {
  compactText,
  containsWords,
  diceSimilarity,
  inDifferentScripts,
  scriptsOf,
  textSimilarity,
  textTokens,
  tokenSetSimilarity,
} from './similarity'

describe('compactText and textTokens', () => {
  it('keep only normalized letters and digits', () => {
    expect(compactText('Hi-Fi, Vol. 1')).toBe('hifivol1')
    expect(compactText('Beyoncé’s  Song!')).toBe('beyoncessong')
    expect(textTokens('Hi-Fi, Vol. 1')).toEqual(['hi', 'fi', 'vol', '1'])
    expect(textTokens('  ')).toEqual([])
  })

  it('keep other scripts and their marks', () => {
    expect(compactText('तुम ही हो')).toBe('तुमहीहो')
    expect(textTokens('アイドル (Idol)')).toEqual(['アイドル', 'idol'])
  })
})

describe('diceSimilarity', () => {
  it('is 1 for texts that differ only in case, accents, spaces or punctuation', () => {
    expect(diceSimilarity('Kate Bush', 'KATEBUSH')).toBe(1)
    expect(diceSimilarity('Mr. Brightside', 'Mr Brightside')).toBe(1)
    expect(diceSimilarity('Beyoncé', 'beyonce')).toBe(1)
  })

  it('scores shared bigrams, counting repeats as often as they occur', () => {
    // "aaaa" has the bigram "aa" three times, "aa" once: 2 × 1 / (3 + 1).
    expect(diceSimilarity('aaaa', 'aa')).toBe(0.5)
    expect(diceSimilarity('night', 'nacht')).toBeCloseTo(0.25)
  })

  it('treats a single character as its own bigram', () => {
    expect(diceSimilarity('a', 'a')).toBe(1)
    expect(diceSimilarity('a', 'b')).toBe(0)
  })

  it('is 0 when either text has no letters or digits', () => {
    expect(diceSimilarity('', 'song')).toBe(0)
    expect(diceSimilarity('song', '!!!')).toBe(0)
  })
})

describe('tokenSetSimilarity', () => {
  it('rewards covering the smaller set, half-weighted by the larger', () => {
    expect(tokenSetSimilarity('Blinding Lights', 'City of Blinding Lights')).toBe(0.75)
    expect(tokenSetSimilarity('Song Title', 'title song')).toBe(1)
    expect(tokenSetSimilarity('a b', 'c d')).toBe(0)
  })

  it('is 0 for empty texts', () => {
    expect(tokenSetSimilarity('', 'song')).toBe(0)
  })
})

describe('textSimilarity', () => {
  it('takes the larger of both measures', () => {
    expect(textSimilarity('Blinding Lights', 'City of Blinding Lights')).toBeCloseTo(0.8125)
    expect(textSimilarity('Title Song', 'Song Title')).toBe(1)
  })
})

describe('containsWords', () => {
  it('finds a run of whole words', () => {
    expect(containsWords('Jeff Buckley Music', 'jeff buckley')).toBe(true)
    expect(containsWords('The Everly Brothers', 'Everly Brothers')).toBe(true)
    expect(containsWords('Queen Naija', 'Queen')).toBe(true)
  })

  it('never matches inside words, out of order or when longer', () => {
    expect(containsWords('Moby', 'Mo')).toBe(false)
    expect(containsWords('Brothers Everly', 'Everly Brothers')).toBe(false)
    expect(containsWords('Bush', 'Kate Bush')).toBe(false)
    expect(containsWords('Song', '')).toBe(false)
  })
})

describe('scriptsOf and inDifferentScripts', () => {
  it('names the writing systems of the letters', () => {
    expect([...scriptsOf('Idol')]).toEqual(['latin'])
    expect([...scriptsOf('アイドル')]).toEqual(['cjk'])
    expect([...scriptsOf('夜に駆ける')]).toEqual(['cjk'])
    expect([...scriptsOf('사랑 2')]).toEqual(['hangul'])
    expect([...scriptsOf('Tum Hi Ho توم هي هو')].sort()).toEqual(['arabic', 'latin'])
    expect([...scriptsOf('ⴰⵣⵓⵍ')]).toEqual(['other'])
    expect(scriptsOf('1975 !').size).toBe(0)
  })

  it('tells titles in different scripts apart', () => {
    expect(inDifferentScripts('Idol', 'アイドル')).toBe(true)
    expect(inDifferentScripts('Tum Hi Ho', 'तुम ही हो')).toBe(true)
    expect(inDifferentScripts('Tum Hi Ho', 'Tum Hi Ho توم هي هو')).toBe(false)
    expect(inDifferentScripts('アイドル', '偶像')).toBe(false)
    expect(inDifferentScripts('1975', 'アイドル')).toBe(false)
  })
})
