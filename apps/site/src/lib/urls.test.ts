import { describe, expect, it } from 'vitest'
import { canonicalUrl, publicPath, routeForFile } from './urls'

const SITE = 'https://fxmusic.pages.dev'

describe('publicPath', () => {
  it.each([
    ['/', '/'],
    ['', '/'],
    ['/index.html', '/'],
    ['/privacy', '/privacy'],
    ['/privacy/', '/privacy'],
    ['/privacy.html', '/privacy'],
    ['privacy', '/privacy'],
    ['/docs/index.html', '/docs'],
    ['/docs/reindex', '/docs/reindex'],
  ])('%j becomes %j', (input, expected) => {
    expect(publicPath(input)).toBe(expected)
  })
})

describe('routeForFile', () => {
  it.each([
    ['index.html', '/'],
    ['privacy.html', '/privacy'],
    ['404.html', '/404'],
    ['docs/index.html', '/docs'],
    ['docs\\setup.html', '/docs/setup'],
  ])('%j is served at %j', (file, route) => {
    expect(routeForFile(file)).toBe(route)
  })
})

describe('canonicalUrl', () => {
  it('builds absolute URLs without .html or a trailing slash', () => {
    expect(canonicalUrl('/', SITE)).toBe(`${SITE}/`)
    expect(canonicalUrl('/privacy/', SITE)).toBe(`${SITE}/privacy`)
    expect(canonicalUrl('/disclaimer.html', new URL(SITE))).toBe(`${SITE}/disclaimer`)
  })
})
