import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { context, FULL, fakeInnerTube, NONE, SIMPLE } from './fixtures/testing'
import { createYouTubeProviders } from './index'
import { createYouTubeMusicProvider } from './music'
import {
  assertYouTubeReachable,
  createYouTubeSession,
  innerTubeLanguage,
  innerTubeRegion,
  leaseVisitorData,
  localeOf,
  type YouTubeSession,
} from './session'
import { createYouTubeVideoProvider } from './video'

describe('the language and region of a call', () => {
  it.each([
    ['en', 'en'],
    ['en-in', 'en-IN'],
    ['pt_BR', 'pt-BR'],
    ['zh-Hant', 'zh-TW'],
    ['zh-Hans', 'zh-CN'],
    ['zh-Hant-HK', 'zh-HK'],
    ['sr-Latn', 'sr-Latn'],
    ['es-419', 'es'],
    ['de-DE-u-co-phonebk', 'de-DE'],
    [' fr-CA ', 'fr-CA'],
    ['', 'en'],
    ['123', 'en'],
    [undefined, 'en'],
  ])('hl for %s is %s', (locale, hl) => {
    expect(innerTubeLanguage(locale)).toBe(hl)
  })

  it('gl is the region in upper case, or nothing', () => {
    expect(innerTubeRegion('in')).toBe('IN')
    expect(innerTubeRegion(' GB ')).toBe('GB')
    expect(innerTubeRegion('USA')).toBeUndefined()
    expect(innerTubeRegion(undefined)).toBeUndefined()
    const fetch = globalThis.fetch
    expect(localeOf(context(fetch, { locale: 'en-GB', region: 'gb' }))).toEqual({
      hl: 'en-GB',
      gl: 'GB',
    })
    expect(localeOf({ ...context(fetch), region: 'Earth' })).toEqual({ hl: 'en' })
  })
})

describe('reachability', () => {
  it('fails fast without any YouTube access, and passes in the simple and full tiers', () => {
    const fetch = globalThis.fetch
    expect(() => assertYouTubeReachable(context(fetch, { capabilities: NONE }))).toThrow(
      expect.objectContaining({ code: 'Unsupported' }),
    )
    expect(() => assertYouTubeReachable(context(fetch, { capabilities: SIMPLE }))).not.toThrow()
    expect(() => assertYouTubeReachable(context(fetch, { capabilities: FULL }))).not.toThrow()
  })
})

describe('the session', () => {
  const ISSUED = 'CgtJc3N1ZWRCeVlUKIiIiIiIiIiIAQ'

  it('leases its visitorData to code of this module, and only for sessions it made', async () => {
    const session = createYouTubeSession({
      visitorDataStore: { load: () => ISSUED, save: () => {}, clear: () => {} },
    })
    const ctx = context(fakeInnerTube().fetch, { capabilities: SIMPLE })
    const lease = await leaseVisitorData(session, ctx)
    expect(lease.visitorData).toBe(ISSUED)
    lease.end()
    const copy: YouTubeSession = { ...session }
    await expect(leaseVisitorData(copy, ctx)).rejects.toSatisfy((error) =>
      isFxmError(error, 'Unsupported'),
    )
  })

  it('shows its visitorData without the leases, which only its requests take', () => {
    const { visitorData } = createYouTubeSession()
    expect(visitorData.current).toBeUndefined()
    expect('lease' in visitorData && typeof visitorData.lease).toBe('function')
    // @ts-expect-error The public type has no lease: an unended one would hold every request.
    expect(visitorData.lease).toBeDefined()
  })

  it('is shared by the providers that are given it, which take no session options then', () => {
    const session = createYouTubeSession({ timeoutMs: 5000 })
    expect(createYouTubeMusicProvider({ session }).session).toBe(session)
    expect(createYouTubeVideoProvider({ session }).session).toBe(session)
    expect(createYouTubeProviders({ session }).music.session).toBe(session)
    expect(createYouTubeProviders({ timeoutMs: 5 }).session).not.toBe(session)
    // @ts-expect-error A session's options are fixed when it is created.
    createYouTubeMusicProvider({ session, timeoutMs: 5 })
    const store = { load: () => undefined, save: () => {}, clear: () => {} }
    // @ts-expect-error The same for the store.
    createYouTubeProviders({ session, visitorDataStore: store })
  })
})
