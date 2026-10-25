import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { BUNDLED_YOUTUBE_CONFIG } from './config'
import { FAKE_VISITOR_DATA } from './fixtures/sanitize'
import searchSongs from './fixtures/search-songs.json'
import suggest from './fixtures/suggest.json'
import {
  context,
  FULL,
  fakeInnerTube,
  json,
  on,
  onSwJsData,
  type Recorded,
  type Route,
  SIMPLE,
  swJsData,
} from './fixtures/testing'
import { createYouTubeMusicProvider } from './music'
import { isVisitorData, parseSwJsData, VisitorData, type VisitorDataStore } from './visitor'

const ISSUED = 'CgtJc3N1ZWRCeVlUKIiIiIiIiIiIAQ'

/** The visitorData a request sent in `context.client`, if any. */
function sentVisitorData(request: Recorded | undefined): unknown {
  const context = request?.body.context as { client?: { visitorData?: unknown } } | undefined
  return context?.client?.visitorData
}

/** A route for InnerTube calls that issues `visitorData` to requests that come without one. */
function issuing(visitorData: string, body: unknown = searchSongs): Route {
  return (request) => {
    if (!request.url.pathname.startsWith('/youtubei/')) return undefined
    const issued = sentVisitorData(request) === undefined ? { visitorData } : {}
    return json({ ...(body as object), responseContext: issued })
  }
}

/** An in-memory store that records what it was asked. */
function memoryStore(
  initial?: string,
): VisitorDataStore & { value: string | undefined; log: string[] } {
  const store = {
    value: initial,
    log: [] as string[],
    load() {
      store.log.push('load')
      return store.value
    },
    save(value: string) {
      store.log.push(`save ${value}`)
      store.value = value
    },
    clear() {
      store.log.push('clear')
      store.value = undefined
    },
  }
  return store
}

describe('sw.js_data', () => {
  it('yields the visitorData at index 13 of the device info', () => {
    expect(parseSwJsData(swJsData(ISSUED))).toBe(ISSUED)
  })

  it('refuses a response without the guard, JSON or a visitorData', () => {
    for (const text of ['[]', ")]}'\n{", ')]}\'\n[["yt.sw.adr",null,[[[]]]]]', swJsData('x')]) {
      expect(() => parseSwJsData(text)).toThrow(expect.objectContaining({ code: 'Parse' }))
    }
  })

  it('accepts visitorData as YouTube writes it, percent-encoded or not', () => {
    expect(isVisitorData('CgtJemVMZlNaRzZacyiYjfnWBjIKCgJJThIEGgAgRw%3D%3D')).toBe(true)
    expect(isVisitorData(FAKE_VISITOR_DATA)).toBe(true)
    expect(isVisitorData('short')).toBe(false)
    expect(isVisitorData('has spaces in it, so no')).toBe(false)
    expect(isVisitorData(42)).toBe(false)
  })
})

describe('the visitorData of a session', () => {
  it('comes from sw.js_data in the full tier, read once for concurrent requests', async () => {
    const youtube = fakeInnerTube(
      onSwJsData(ISSUED),
      on('search', {}, searchSongs),
      on('music/get_search_suggestions', {}, suggest),
    )
    const music = createYouTubeMusicProvider()
    const ctx = context(youtube.fetch, { capabilities: FULL })
    await Promise.all([
      music.search('Radiohead Creep', { types: ['track'] }, ctx),
      music.suggest('radioh', ctx),
    ])
    const swJsDataRequests = youtube.requests.filter((r) => r.url.pathname === '/sw.js_data')
    expect(swJsDataRequests).toHaveLength(1)
    const calls = youtube.requests.filter((r) => r.url.pathname.startsWith('/youtubei/'))
    expect(calls.map(sentVisitorData)).toEqual([ISSUED, ISSUED])
    expect(music.session.visitorData.current).toBe(ISSUED)
  })

  it('comes from the first InnerTube answer in the simple tier, never made up locally', async () => {
    const youtube = fakeInnerTube(issuing(ISSUED))
    const music = createYouTubeMusicProvider()
    const ctx = context(youtube.fetch, { capabilities: SIMPLE })
    await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    expect(youtube.requests.some((r) => r.url.pathname === '/sw.js_data')).toBe(false)
    expect(youtube.requests.map(sentVisitorData)).toEqual([undefined, ISSUED])
    expect(youtube.requests[0]?.rawBody).not.toContain('visitorData')
  })

  it('makes requests that start before the first answer wait for it', async () => {
    const youtube = fakeInnerTube(issuing(ISSUED))
    const music = createYouTubeMusicProvider()
    const ctx = context(youtube.fetch, { capabilities: SIMPLE })
    await Promise.all(
      ['a', 'b', 'c'].map((query) => music.search(query, { types: ['track'] }, ctx)),
    )
    expect(youtube.requests.map(sentVisitorData)).toEqual([undefined, ISSUED, ISSUED])
  })

  it('falls back to the first answer when sw.js_data cannot be read, and stops trying it', async () => {
    const youtube = fakeInnerTube(onSwJsData(ISSUED, 403), on('search', {}, searchSongs))
    const music = createYouTubeMusicProvider()
    const ctx = context(youtube.fetch, { capabilities: FULL })
    await music.search('a', { types: ['track'] }, ctx)
    await music.search('b', { types: ['track'] }, ctx)
    music.session.visitorData.invalidate()
    await music.search('c', { types: ['track'] }, ctx)
    expect(youtube.requests.map((r) => r.url.pathname)).toEqual([
      '/sw.js_data',
      '/youtubei/v1/search',
      '/youtubei/v1/search',
      '/sw.js_data',
      '/youtubei/v1/search',
    ])
    expect(youtube.requests.filter((r) => r.method === 'POST').map(sentVisitorData)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  it('goes on when the first request fails, with the next one asking again', async () => {
    let failed = false
    const youtube = fakeInnerTube((request) => {
      if (!failed) {
        failed = true
        return json({ error: { message: 'boom' } }, { status: 500 })
      }
      return issuing(ISSUED)(request)
    })
    const music = createYouTubeMusicProvider()
    const ctx = context(youtube.fetch, { capabilities: SIMPLE })
    const results = await Promise.allSettled([
      music.search('a', { types: ['track'] }, ctx),
      music.search('b', { types: ['track'] }, ctx),
    ])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled'])
    expect(youtube.requests.map(sentVisitorData)).toEqual([undefined, undefined])
    expect(music.session.visitorData.current).toBe(ISSUED)
  })

  it('is persisted through an injected store, and read from it first', async () => {
    const store = memoryStore()
    const youtube = fakeInnerTube(issuing(ISSUED))
    const music = createYouTubeMusicProvider({ visitorDataStore: store })
    await music.search('a', { types: ['track'] }, context(youtube.fetch, { capabilities: SIMPLE }))
    expect(store.log).toEqual(['load', `save ${ISSUED}`])
    const later = fakeInnerTube(issuing('CgtOZXdlclZpc2l0b3IoAQ'))
    const reloaded = createYouTubeMusicProvider({ visitorDataStore: store })
    await reloaded.search('a', { types: ['track'] }, context(later.fetch, { capabilities: SIMPLE }))
    expect(later.requests.map(sentVisitorData)).toEqual([ISSUED])
  })

  it('ignores a store that fails or holds garbage', async () => {
    const broken: VisitorDataStore = {
      load: () => Promise.reject(new Error('quota')),
      save: () => {
        throw new Error('quota')
      },
      clear: () => {},
    }
    const youtube = fakeInnerTube(issuing(ISSUED))
    const music = createYouTubeMusicProvider({ visitorDataStore: broken })
    await music.search('a', { types: ['track'] }, context(youtube.fetch, { capabilities: SIMPLE }))
    expect(music.session.visitorData.current).toBe(ISSUED)
    const garbage = createYouTubeMusicProvider({ visitorDataStore: memoryStore('not valid!') })
    const fresh = fakeInnerTube(issuing(ISSUED))
    await garbage.search('a', { types: ['track'] }, context(fresh.fetch, { capabilities: SIMPLE }))
    expect(fresh.requests.map(sentVisitorData)).toEqual([undefined])
  })

  it('is dropped after a bot check, so the next request gets a fresh one', async () => {
    const store = memoryStore(ISSUED)
    let botCheck = true
    const youtube = fakeInnerTube((request) => {
      if (botCheck) {
        botCheck = false
        return json({ playabilityStatus: { status: 'LOGIN_REQUIRED' } })
      }
      return issuing('CgtGcmVzaFZpc2l0b3IoAQ')(request)
    })
    const music = createYouTubeMusicProvider({ visitorDataStore: store })
    const ctx = context(youtube.fetch, { capabilities: SIMPLE })
    await expect(music.search('a', { types: ['track'] }, ctx)).rejects.toSatisfy((error) =>
      isFxmError(error, 'BotCheck'),
    )
    expect(store.log).toContain('clear')
    await music.search('a', { types: ['track'] }, ctx)
    expect(youtube.requests.map(sentVisitorData)).toEqual([ISSUED, undefined])
    expect(music.session.visitorData.current).toBe('CgtGcmVzaFZpc2l0b3IoAQ')
  })

  it('stops waiting for the first answer when the caller cancels', async () => {
    let answer: (() => void) | undefined
    const youtube = fakeInnerTube()
    const slow: typeof fetch = (input, init) =>
      new Promise((resolve, reject) => {
        answer = () => resolve(youtube.fetch(input, init))
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    const visitorData = new VisitorData(BUNDLED_YOUTUBE_CONFIG.visitorData.swJsDataUrl)
    const first = await visitorData.lease(context(slow, { capabilities: SIMPLE }))
    expect(first.visitorData).toBeUndefined()
    const controller = new AbortController()
    const waiting = visitorData.lease(
      context(slow, { capabilities: SIMPLE, signal: controller.signal }),
    )
    controller.abort(new DOMException('stop', 'AbortError'))
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    first.end(ISSUED)
    expect(visitorData.current).toBe(ISSUED)
    expect(answer).toBeUndefined()
  })
})
