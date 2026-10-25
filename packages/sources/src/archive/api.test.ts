import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { contextFor, fakeService, json } from '../shared/fake-fetch'
import { ArchiveApi, type ArchiveSearch, searchQuery } from './api'
import missing from './fixtures/item-missing.json'
import ninGhosts from './fixtures/item-nin-ghosts.json'
import searchNinGhosts from './fixtures/search-nin-ghosts.json'

const api = (now?: () => number) =>
  new ArchiveApi({
    timeoutMs: 5000,
    searchTtlMs: 1000,
    itemTtlMs: 1000,
    ...(now === undefined ? {} : { now }),
  })

const ghosts: ArchiveSearch = {
  text: 'Nine Inch Nails: Ghosts',
  mediatypes: ['audio', 'etree'],
  rows: 5,
  page: 1,
  sort: 'downloads',
}

describe('searchQuery', () => {
  it('asks for free items with a FLAC file that match every word', () => {
    expect(searchQuery('Nine Inch Nails: Ghosts', ['audio', 'etree'])).toBe(
      'mediatype:(audio OR etree) AND format:flac AND NOT access-restricted-item:true AND ' +
        '(nine inch nails ghosts)',
    )
  })

  it('adds alternatives of which one must match, each once', () => {
    expect(
      searchQuery('Nine Inch Nails', ['audio'], ['1 Ghosts I', 'Ghosts I-IV', 'ghosts i iv', '!!']),
    ).toBe(
      'mediatype:(audio) AND format:flac AND NOT access-restricted-item:true AND ' +
        '(nine inch nails) AND ((1 ghosts i) OR (ghosts i iv))',
    )
  })

  it('keeps nothing a user types from changing the query', () => {
    const query = searchQuery(
      'x) OR (mediatype:texts AND title:"a*" OR NOT -foo:[1 TO 2] {b} ~c^2 \\ /d/ && e || f !g',
      ['audio'],
    )
    expect(query).toBe(
      'mediatype:(audio) AND format:flac AND NOT access-restricted-item:true AND ' +
        '(x or mediatype texts and title a or not foo 1 to 2 b c 2 d e f g)',
    )
    expect(searchQuery('Beyoncé – Halo', ['audio'])).toMatch(/\(beyonce halo\)$/u)
    expect(searchQuery('米津玄師 Lemon', ['audio'])).toMatch(/\(米津玄師 lemon\)$/u)
  })

  it('has nothing to search without words or valid media types', () => {
    expect(searchQuery(' -- !! ', ['audio'])).toBeNull()
    expect(searchQuery('ghosts', [])).toBeNull()
    expect(searchQuery('ghosts', ['audio) OR (texts'])).toBeNull()
  })
})

describe('ArchiveApi.search', () => {
  it('sends the query, fields, order and paging as advanced search wants them', async () => {
    const service = fakeService(() => json(searchNinGhosts))
    await api().search({ ...ghosts, page: 3 }, contextFor(service.fetch))
    const url = service.calls[0]?.url
    expect(`${url?.origin}${url?.pathname}`).toBe('https://archive.org/advancedsearch.php')
    expect(url?.searchParams.get('q')).toBe(searchQuery(ghosts.text, ghosts.mediatypes))
    expect(url?.searchParams.getAll('fl[]')).toEqual([
      'identifier',
      'title',
      'creator',
      'date',
      'year',
      'mediatype',
      'downloads',
    ])
    expect(url?.searchParams.get('sort[]')).toBe('downloads desc')
    expect(url?.searchParams.get('rows')).toBe('5')
    expect(url?.searchParams.get('page')).toBe('3')
    expect(url?.searchParams.get('output')).toBe('json')
    expect([...(service.calls[0]?.headers.keys() ?? [])]).toEqual([])
    expect(service.calls[0]?.init?.credentials).toBe('omit')
  })

  it('reads the items it found', async () => {
    const service = fakeService(() => json(searchNinGhosts))
    const page = await api().search(ghosts, contextFor(service.fetch))
    expect(page.total).toBe(46)
    expect(page.docs).toHaveLength(5)
    expect(page.docs[0]).toEqual({
      identifier: 'nineinchnails_ghosts_I_IV',
      title: 'Ghosts I - IV',
      creators: ['Nine Inch Nails'],
      date: '2008-03-02',
      mediatype: 'audio',
      downloads: 311427,
    })
    expect(page.docs[1]).not.toHaveProperty('date')
  })

  it('leaves the order to the Archive when asked for relevance', async () => {
    const service = fakeService(() => json(searchNinGhosts))
    await api().search({ ...ghosts, sort: 'relevance' }, contextFor(service.fetch))
    expect(service.calls[0]?.url.searchParams.has('sort[]')).toBe(false)
  })

  it('makes no request when no word is left', async () => {
    const service = fakeService(() => json(searchNinGhosts))
    await expect(
      api().search({ ...ghosts, text: '?!' }, contextFor(service.fetch)),
    ).resolves.toEqual({
      total: 0,
      docs: [],
    })
    expect(service.calls).toHaveLength(0)
  })

  it('keeps a page for a while', async () => {
    let now = 0
    const service = fakeService(() => json(searchNinGhosts))
    const archive = api(() => now)
    await archive.search(ghosts, contextFor(service.fetch))
    await archive.search(ghosts, contextFor(service.fetch))
    now = 1000
    await archive.search(ghosts, contextFor(service.fetch))
    expect(service.calls).toHaveLength(2)
  })

  it('maps failures to typed errors', async () => {
    const cases: Array<[Response, string]> = [
      [json({}, { status: 429, headers: { 'retry-after': '30' } }), 'RateLimited'],
      [json({}, { status: 502 }), 'Unavailable'],
      [json({ responseHeader: { status: 400 }, error: 'bad query' }), 'Parse'],
    ]
    for (const [response, code] of cases) {
      const service = fakeService(() => response)
      const error = await api()
        .search(ghosts, contextFor(service.fetch))
        .catch((caught: unknown) => caught)
      expect(isFxmError(error, code as 'Parse')).toBe(true)
    }
  })
})

describe('ArchiveApi.item', () => {
  it('loads an item once for everyone asking at the same time', async () => {
    const service = fakeService(() => json(ninGhosts))
    const archive = api()
    const ctx = contextFor(service.fetch)
    const [first, second] = await Promise.all([
      archive.item('nineinchnails_ghosts_I_IV', ctx),
      archive.item('nineinchnails_ghosts_I_IV', ctx),
    ])
    expect(first).toBe(second)
    expect(first.title).toBe('Ghosts I - IV')
    expect(service.calls.map((call) => call.url.href)).toEqual([
      'https://archive.org/metadata/nineinchnails_ghosts_I_IV',
    ])
  })

  it('rejects an unknown item with NotFound, and tries again next time', async () => {
    const service = fakeService(() => json(missing))
    const archive = api()
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await archive
        .item('nothing-here', contextFor(service.fetch))
        .catch((caught: unknown) => caught)
      expect(isFxmError(error, 'NotFound')).toBe(true)
    }
    expect(service.calls).toHaveLength(2)
  })

  it('maps HTTP failures to typed errors', async () => {
    const service = fakeService(() => json({}, { status: 503 }))
    const error = await api()
      .item('busy', contextFor(service.fetch))
      .catch((caught: unknown) => caught)
    expect(isFxmError(error, 'Unavailable')).toBe(true)
  })
})
