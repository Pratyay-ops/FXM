import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { BUNDLED_YOUTUBE_CONFIG } from './config'
import searchSongs from './fixtures/search-songs.json'
import { context, fakeInnerTube, on, onSwJsData, preflightReason, SIMPLE } from './fixtures/testing'
import { createYouTubeMusicProvider } from './music'
import { namesOnlyIds, SIMPLE_CONTENT_TYPE, toSimpleInnerTubeRequest } from './request'
import { createYouTubeSession } from './session'

const config = BUNDLED_YOUTUBE_CONFIG

/** A request body as youtubei.js builds it: a desktop browser's context and its own fields. */
const youtubeiBody = JSON.stringify({
  query: 'Radiohead Creep',
  params: 'P',
  isAudioOnly: true,
  client: 'YTMUSIC',
  context: {
    client: {
      hl: 'en',
      gl: 'US',
      remoteHost: '',
      screenWidthPoints: 2560,
      visitorData: 'locally-generated',
      clientName: 'WEB_REMIX',
      clientVersion: '1.20250219.01.00',
      osName: 'Windows',
      userAgent: 'Mozilla/5.0 (random)',
      timeZone: 'Asia/Calcutta',
      utcOffsetMinutes: 330,
      mainAppWebInfo: { graftUrl: 'https://www.youtube.com' },
    },
    user: { enableSafetyMode: false, lockedSafetyMode: false },
  },
})

describe('the CORS-simple request shape', () => {
  it('keeps the payload and writes the host, query, headers and context itself', () => {
    const request = toSimpleInnerTubeRequest(
      'https://www.youtube.com/youtubei/v1/search?prettyPrint=false&alt=json',
      youtubeiBody,
      { config, client: config.clients.music, hl: 'en-GB', gl: 'IN', visitorData: 'server-issued' },
    )
    expect(request.url).toBe('https://music.youtube.com/youtubei/v1/search?prettyPrint=false')
    expect(request.endpoint).toBe('search')
    expect(request.init).toEqual({
      method: 'POST',
      headers: { 'Content-Type': SIMPLE_CONTENT_TYPE },
      body: request.init.body,
      credentials: 'omit',
    })
    expect(JSON.parse(request.init.body)).toEqual({
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: config.clients.music.version,
          hl: 'en-GB',
          gl: 'IN',
          visitorData: 'server-issued',
        },
        user: { lockedSafetyMode: false },
        request: { useSsl: true },
      },
      query: 'Radiohead Creep',
      params: 'P',
      isAudioOnly: true,
    })
  })

  it('leaves out the region and visitorData it does not have', () => {
    const request = toSimpleInnerTubeRequest('/youtubei/v1/browse', '{"browseId":"UC1"}', {
      config,
      client: config.clients.web,
      hl: 'en',
    })
    expect(request.url).toBe('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false')
    expect(request.body.context).toEqual({
      client: { clientName: 'WEB', clientVersion: config.clients.web.version, hl: 'en' },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    })
  })

  it('keeps the client fields youtubei.js wrote for a client the config does not list', () => {
    const body = JSON.stringify({
      videoId: 'dQw4w9WgXcQ',
      context: {
        client: {
          clientName: 'VISIONOS',
          clientVersion: '1.02',
          deviceMake: 'Apple',
          osName: 'visionOS',
          timeZone: 'Asia/Calcutta',
          visitorData: 'local',
        },
        thirdParty: { embedUrl: 'https://www.youtube.com' },
      },
    })
    const request = toSimpleInnerTubeRequest('https://www.youtube.com/youtubei/v1/player', body, {
      config,
      hl: 'en',
      visitorData: 'server-issued',
    })
    expect(request.host).toBe(config.defaultHost)
    expect(request.body.context).toEqual({
      client: {
        clientName: 'VISIONOS',
        clientVersion: '1.02',
        deviceMake: 'Apple',
        osName: 'visionOS',
        hl: 'en',
        visitorData: 'server-issued',
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
      thirdParty: { embedUrl: 'https://www.youtube.com' },
    })
  })

  it('takes the version and host of a listed client by its name', () => {
    const request = toSimpleInnerTubeRequest('/youtubei/v1/next', youtubeiBody, {
      config,
      hl: 'en',
    })
    expect(request.host).toBe('music.youtube.com')
    expect(request.body.context).toMatchObject({
      client: { clientName: 'WEB_REMIX', clientVersion: config.clients.music.version },
    })
  })

  it('tells a request that names only an entity from one YouTube could refuse otherwise', () => {
    expect(namesOnlyIds({ context: {}, browseId: 'MPREb_DciERiuADkS' })).toBe(true)
    expect(namesOnlyIds({ videoId: 'zFYEYRcjK2g', isAudioOnly: true })).toBe(true)
    expect(
      namesOnlyIds({ videoId: 'zFYEYRcjK2g', playlistId: 'RDAMVMzFYEYRcjK2g', params: 'wAEB' }),
    ).toBe(false)
    expect(namesOnlyIds({ browseId: 'UC1', params: 'x' })).toBe(false)
    expect(namesOnlyIds({ continuation: 'c' })).toBe(false)
    expect(namesOnlyIds({ query: 'Creep' })).toBe(false)
    expect(namesOnlyIds({ videoId: 42 })).toBe(false)
  })

  it('refuses endpoints outside the allowlist and bodies that are not JSON objects', () => {
    for (const endpoint of ['config', 'att/get', 'visitor_id', 'account/account_menu']) {
      expect(() =>
        toSimpleInnerTubeRequest(`https://www.youtube.com/youtubei/v1/${endpoint}`, '{}', {
          config,
          hl: 'en',
        }),
      ).toThrow(expect.objectContaining({ code: 'Unsupported' }))
    }
    for (const body of ['', '[1]', 'not json']) {
      expect(() =>
        toSimpleInnerTubeRequest('/youtubei/v1/search', body, { config, hl: 'en' }),
      ).toThrow(expect.objectContaining({ code: 'Parse' }))
    }
  })
})

describe('requests through youtubei.js', () => {
  it('reach ctx.fetch CORS-simple, without the headers youtubei.js adds', async () => {
    const youtube = fakeInnerTube(on('search', {}, searchSongs))
    const music = createYouTubeMusicProvider()
    const ctx = context(youtube.fetch, { mode: 'music', capabilities: SIMPLE, locale: 'pt-br' })
    await music.search('Radiohead Creep', { types: ['track'] }, ctx)
    expect(youtube.requests).toHaveLength(1)
    const [request] = youtube.requests
    expect(request?.method).toBe('POST')
    expect(request && preflightReason(request)).toBeUndefined()
    expect([...(request?.headers.keys() ?? [])]).toEqual(['content-type'])
    expect(request?.headers.get('content-type')).toBe(SIMPLE_CONTENT_TYPE)
    expect(request?.credentials).toBe('omit')
    expect(request?.url.href).toBe('https://music.youtube.com/youtubei/v1/search?prettyPrint=false')
    expect(request?.body).toMatchObject({
      context: { client: { clientName: 'WEB_REMIX', hl: 'pt-BR', gl: 'IN' } },
      query: 'Radiohead Creep',
      params: config.search.music.songs,
    })
    expect(request?.rawBody).not.toMatch(/userAgent|timeZone|locally|osName|screen/)
  })

  it('send the server-issued visitorData in context.client, never in a header', async () => {
    const youtube = fakeInnerTube(onSwJsData('CgtTZXJ2ZXJJc3N1ZWQ'), on('search', {}, searchSongs))
    const music = createYouTubeMusicProvider()
    await music.search('Radiohead Creep', { types: ['track'] }, context(youtube.fetch))
    const [swJsData, search] = youtube.requests
    expect(swJsData?.url.href).toBe(config.visitorData.swJsDataUrl)
    expect(swJsData?.method).toBe('GET')
    expect(swJsData?.credentials).toBe('omit')
    expect([...(swJsData?.headers.keys() ?? [])]).toEqual([])
    expect(search?.body).toMatchObject({
      context: { client: { visitorData: 'CgtTZXJ2ZXJJc3N1ZWQ' } },
    })
    expect(search?.headers.has('x-goog-visitor-id')).toBe(false)
  })

  it('give youtubei.js an Innertube for other code, such as the stream resolver', async () => {
    const youtube = fakeInnerTube(on('next', {}, { contents: {} }))
    const session = createYouTubeSession()
    const innertube = await session.innertube(context(youtube.fetch, { capabilities: SIMPLE }))
    await innertube.actions.execute('/next', { videoId: 'dQw4w9WgXcQ', client: 'YTMUSIC' })
    const [request] = youtube.requests
    expect(request && preflightReason(request)).toBeUndefined()
    expect(request?.url.host).toBe('music.youtube.com')
  })

  it('refuse youtubei.js calls to endpoints outside the allowlist', async () => {
    const youtube = fakeInnerTube()
    const session = createYouTubeSession()
    const innertube = await session.innertube(context(youtube.fetch, { capabilities: SIMPLE }))
    await expect(innertube.actions.execute('/att/get', {})).rejects.toSatisfy((error) =>
      isFxmError(error, 'Unsupported'),
    )
    expect(youtube.requests).toEqual([])
  })

  it('reach InnerTube through the session for both clients', async () => {
    const youtube = fakeInnerTube(on('browse', { browseId: 'UC1' }, { contents: {} }))
    const session = createYouTubeSession()
    const ctx = context(youtube.fetch, { capabilities: SIMPLE, region: 'gb' })
    await session.call(ctx, 'web', 'browse', { browseId: 'UC1' })
    expect(youtube.requests[0]?.url.host).toBe('www.youtube.com')
    expect(youtube.requests[0]?.body).toMatchObject({
      context: { client: { clientName: 'WEB', gl: 'GB' } },
      browseId: 'UC1',
    })
  })
})
