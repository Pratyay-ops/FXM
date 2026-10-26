import { describe, expect, it } from 'vitest'
import { createEmbedServices, embedPlatformOptions } from './integration'
import { EMBED_SOURCES } from './target'
import { createFakePlatform } from './testing/fake-platform'
import { WIRED_SOURCES } from './wired'

describe('the integration touch-points', () => {
  it('name exactly the sources the catalog loads, each with a stream source', () => {
    const services = createEmbedServices(createFakePlatform())
    for (const source of EMBED_SOURCES) {
      expect(services.catalog.supports(source), source).toBe(WIRED_SOURCES.has(source))
    }
    // Plain YouTube plays through the YouTube Music ladder (`ytm`), as the player resolves it.
    const streams = new Set(services.sources.map((stream) => stream.id))
    for (const source of WIRED_SOURCES) {
      expect(streams.has(source === 'yt' ? 'ytm' : source), source).toBe(true)
    }
  })

  it('keep the Lite tier off until the remote kill switch is wired in', () => {
    // Vitest runs in the `test` mode; only the browser tests' build (`--mode e2e`) turns it on.
    const { killSwitches } = embedPlatformOptions()
    const switches = typeof killSwitches === 'function' ? killSwitches() : killSwitches?.get()
    expect(switches).toEqual({ lite: true })
  })
})
