import { describe, expect, it } from 'vitest'
import { canonicalAppPath } from './canonical-path'

describe('canonicalAppPath', () => {
  it('spells out an encoded base, and keeps the rest of the address as it was', () => {
    expect(canonicalAppPath('/%61pp/', '/app/')).toBe('/app/')
    expect(canonicalAppPath('/%61%70%70/search', '/app/')).toBe('/app/search')
    expect(canonicalAppPath('/ap%70%2Fsearch', '/app/')).toBe('/app/search')
    // An encoded slash inside an ID stays encoded: only the base is decoded.
    expect(canonicalAppPath('/%61pp/album/ytm:a%2Fb', '/app/')).toBe('/app/album/ytm:a%2Fb')
  })

  it('leaves plain addresses, other paths and broken escapes alone', () => {
    expect(canonicalAppPath('/app/search', '/app/')).toBeUndefined()
    expect(canonicalAppPath('/privacy', '/app/')).toBeUndefined()
    expect(canonicalAppPath('/%61pp/%E0%A4', '/app/')).toBeUndefined()
    // The desktop and Android builds serve the app from the root: nothing to spell out.
    expect(canonicalAppPath('/%61pp/', '/')).toBeUndefined()
  })
})
