import { describe, expect, it } from 'vitest'
import { noticesUrl, PUBLIC_NOTICES_URL } from './notices'

describe('the third-party notices', () => {
  it('are the deploy’s own for the web app, and the site’s for the other builds', () => {
    // The web app at /app/: production, a preview or a self-hosted copy, each with its notices.
    expect(noticesUrl('/app/')).toBe('/third-party-notices.txt')
    // The desktop and Android builds, served from /: FXM's own site.
    expect(noticesUrl('/')).toBe(PUBLIC_NOTICES_URL)
    expect(PUBLIC_NOTICES_URL).toBe('https://fxmusic.pages.dev/third-party-notices.txt')
    // The tests run as the web build.
    expect(noticesUrl()).toBe('/third-party-notices.txt')
  })
})
