import { describe, expect, it } from 'vitest'
import { RECORDED_FIXTURES } from './all'
import { FAKE_VISITOR_DATA, MAX_TEXT, sanitizeResponse, truncateItems } from './sanitize'

describe('the fixture sanitizer', () => {
  it('replaces visitorData and IP addresses, and drops tracking and logging fields', () => {
    const clean = sanitizeResponse({
      responseContext: {
        visitorData: 'CgtSZWFsVmlzaXRvcg',
        serviceTrackingParams: [{ params: [] }],
      },
      trackingParams: 'CAAQ',
      contents: {
        item: {
          clickTrackingParams: 'CBMQ',
          url: 'https://rr1---sn-x.googlevideo.com/initplayback?ip=1.1.1.1&ipv6=2606:4700:4700:0:0:0:0:1111',
          loggingDirectives: { visibility: {} },
          accessibility: { accessibilityData: { label: 'x' } },
          context: { client: { visitorData: 'CgtSZWFs' } },
        },
      },
      frameworkUpdates: { entityBatchUpdate: {} },
      microformat: {
        microformatDataRenderer: { title: 'Pablo Honey', videoDetails: { comments: [] } },
      },
    })
    expect(clean).toEqual({
      responseContext: { visitorData: FAKE_VISITOR_DATA },
      contents: {
        item: {
          url: 'https://rr1---sn-x.googlevideo.com/initplayback?ip=192.0.2.1&ipv6=2001:db8::1',
          context: { client: { visitorData: FAKE_VISITOR_DATA } },
        },
      },
      microformat: { microformatDataRenderer: { title: 'Pablo Honey' } },
    })
  })

  it('keeps only the "View song credits" items of menus, and cuts long texts', () => {
    const credits = {
      menuNavigationItemRenderer: {
        navigationEndpoint: { browseEndpoint: { browseId: 'MPTCzFYEYRcjK2g' } },
      },
    }
    const clean = sanitizeResponse({
      menu: {
        menuRenderer: {
          items: [
            { menuServiceItemRenderer: { serviceEndpoint: { queueAddEndpoint: {} } } },
            { menuNavigationItemRenderer: { navigationEndpoint: { watchEndpoint: {} } } },
            credits,
            { toggleMenuServiceItemRenderer: {} },
          ],
        },
      },
      description: { runs: [{ text: 'x'.repeat(1000) }] },
    }) as {
      menu: { menuRenderer: { items: unknown[] } }
      description: { runs: { text: string }[] }
    }
    expect(clean.menu.menuRenderer.items).toEqual([credits])
    expect(clean.description.runs[0]?.text).toHaveLength(MAX_TEXT + 1)
  })

  it('shortens lists of items, keeping their continuation, and leaves other lists whole', () => {
    const row = (n: number) => ({ musicResponsiveListItemRenderer: { n } })
    const continuation = { continuationItemRenderer: { continuationEndpoint: {} } }
    const page = {
      sections: [{ a: 1 }, { b: 2 }, { c: 3 }],
      contents: [row(1), row(2), row(3), row(4), continuation],
    }
    expect(truncateItems(page, 2)).toEqual({
      sections: [{ a: 1 }, { b: 2 }, { c: 3 }],
      contents: [row(1), row(2), continuation],
    })
    expect(truncateItems({ contents: [row(1)] }, 2)).toEqual({ contents: [row(1)] })
  })
})

describe('the recorded fixtures', () => {
  const entries = Object.entries(RECORDED_FIXTURES).map(
    ([name, json]) => [name, JSON.stringify(json)] as const,
  )

  it('are all there', () => {
    expect(entries.length).toBeGreaterThanOrEqual(25)
  })

  it.each(entries)('%s holds no IP address, real visitorData or tracking field', (_name, text) => {
    expect(text).not.toMatch(/\b(?!192\.0\.2\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/u)
    expect(text).not.toMatch(/"(?:trackingParams|clickTrackingParams|serviceTrackingParams)"/u)
    for (const match of text.matchAll(/"visitorData":"([^"]*)"/gu)) {
      expect(match[1]).toBe(FAKE_VISITOR_DATA)
    }
  })
})
