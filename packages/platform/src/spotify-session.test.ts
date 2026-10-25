import { describe, expect, it, vi } from 'vitest'
import type { ConnectClient } from './connect'
import { connectSessionSource } from './spotify-session'

describe('connectSessionSource', () => {
  it('asks FXM Connect’s bridge for the token, passing the signal on', async () => {
    const spotifyToken = vi.fn<ConnectClient['spotifyToken']>(async () => ({
      status: 200,
      json: { accessToken: 'token', isAnonymous: false },
    }))
    const source = connectSessionSource({ spotifyToken })
    const controller = new AbortController()
    const params = { reason: 'transport', productType: 'web-player', totp: '123456' }
    await expect(source.requestToken(params, { signal: controller.signal })).resolves.toEqual({
      status: 200,
      json: { accessToken: 'token', isAnonymous: false },
    })
    expect(spotifyToken).toHaveBeenLastCalledWith(params, { signal: controller.signal })
    // A provider's whole context can be passed as the options.
    await source.requestToken(params, { mode: 'music', signal: controller.signal } as never)
    expect(spotifyToken).toHaveBeenLastCalledWith(params, { signal: controller.signal })
    await source.requestToken(params)
    expect(spotifyToken).toHaveBeenLastCalledWith(params, {})
  })
})
