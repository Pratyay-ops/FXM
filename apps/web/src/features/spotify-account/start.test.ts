import type { ProviderContext } from '@fxm/core'
import { afterEach, describe, expect, it } from 'vitest'
import { appHomeServices } from '../home/services'
import {
  appAccountChoice,
  currentAppAccountRuntime,
  spotifyAccountForHome,
  spotifyAccountOptedIn,
  startSpotifyAccount,
} from './start'

const ctx: ProviderContext = {
  fetch: () => Promise.reject(new Error('never')),
  platform: 'web',
  capabilities: { youtube: 'full', spotify: 'account', mediaBytes: true, fileSystem: false },
  mode: 'music',
}

const before = appHomeServices.get()
afterEach(() => {
  appHomeServices.set(before)
})

describe('startSpotifyAccount', () => {
  it('gives Home its view of the account, and loads nothing until the user connects', async () => {
    startSpotifyAccount()
    expect(appHomeServices.get().spotifyAccount).toBe(spotifyAccountForHome)
    expect(appHomeServices.get().sources).toBe(before.sources)
    expect(spotifyAccountOptedIn()).toBe(false)
    expect(appAccountChoice.getState().optedIn).toBe(false)
    expect(await spotifyAccountForHome.status(ctx)).toEqual({ connected: false })
    expect(await spotifyAccountForHome.sections(ctx)).toEqual([])
    expect(currentAppAccountRuntime()).toBeUndefined()
  })
})
