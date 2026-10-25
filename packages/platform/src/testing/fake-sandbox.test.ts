import { isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { SIMPLE_CONTENT_TYPE, type SimpleInnerTubeRequest } from '../innertube'
import { createFakeSandbox, SANDBOX_INNERTUBE_PATHS } from './fake-sandbox'

function simple(path: string, init: Partial<SimpleInnerTubeRequest['init']> = {}) {
  return {
    url: `https://music.youtube.com${path}?prettyPrint=false`,
    init: {
      method: 'POST',
      headers: { 'content-type': SIMPLE_CONTENT_TYPE },
      body: '{}',
      credentials: 'omit',
      ...init,
    },
  } as SimpleInnerTubeRequest
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('createFakeSandbox', () => {
  it('accepts CORS-simple calls to the allowed paths and records them', async () => {
    const sandbox = createFakeSandbox()
    for (const path of SANDBOX_INNERTUBE_PATHS) {
      await expect(sandbox.innerTube(simple(path))).resolves.toBeInstanceOf(Response)
    }
    expect(sandbox.requests).toHaveLength(SANDBOX_INNERTUBE_PATHS.length)
    await expect(sandbox.selfTest()).resolves.toBe(true)
    expect(sandbox.selfTests).toBe(1)
    expect(sandbox.userHost).toBeUndefined()
  })

  it.each([
    ['another path', simple('/youtubei/v1/guide')],
    [
      'a preflighted header',
      simple('/youtubei/v1/search', { headers: { 'x-goog-visitor-id': 'v' } }),
    ],
    [
      'a JSON content type',
      simple('/youtubei/v1/search', { headers: { 'content-type': 'application/json' } }),
    ],
    ['credentials', simple('/youtubei/v1/search', { credentials: 'include' as 'omit' })],
    ['a byte body', simple('/youtubei/v1/search', { body: new Uint8Array() as unknown as string })],
    [
      'another host',
      { ...simple('/youtubei/v1/search'), url: 'https://example.com/youtubei/v1/search' },
    ],
  ])('refuses %s', async (_case, request) => {
    const sandbox = createFakeSandbox()
    expect(isFxmError(await rejection(sandbox.innerTube(request)), 'Unsupported')).toBe(true)
    expect(sandbox.requests).toEqual([])
  })

  it('answers from the handlers it is given', async () => {
    const sandbox = createFakeSandbox({
      selfTest: async () => false,
      respond: () => Response.json({ handled: true }),
      userHost: () => new Response('user'),
      paths: ['/youtubei/v1/search'],
    })
    await expect(sandbox.selfTest()).resolves.toBe(false)
    await expect((await sandbox.innerTube(simple('/youtubei/v1/search'))).json()).resolves.toEqual({
      handled: true,
    })
    await expect(
      (await sandbox.userHost?.('https://x.example/', { method: 'GET' }))?.text(),
    ).resolves.toBe('user')
    expect(sandbox.userHostRequests).toEqual([
      { url: 'https://x.example/', init: { method: 'GET' } },
    ])
  })
})
