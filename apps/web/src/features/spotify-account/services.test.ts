import { isFxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { createAccountChoice, SPOTIFY_ACCOUNT_STORAGE_KEY } from './account-store'
import { createSecretFetch } from './services'

const HOSTS = ['raw.githubusercontent.com', 'gist.githubusercontent.com']
const SECRET = 'https://raw.githubusercontent.com/someone/secrets/main/secret.json'

describe('the secret fetch', () => {
  it('reads the secret through the sandboxed user-host document, GET only', async () => {
    const userHost = vi.fn(async () => new Response('{"7":[1,2,3]}'))
    const fetch = createSecretFetch({ hosts: HOSTS, userHost })
    const controller = new AbortController()
    const response = await fetch(SECRET, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      signal: controller.signal,
    })
    expect(await response.text()).toBe('{"7":[1,2,3]}')
    expect(userHost).toHaveBeenCalledWith(SECRET, { method: 'GET', signal: controller.signal })
  })

  it('reads it directly where there is no such document (make dev), without credentials', async () => {
    const direct = vi.fn(async () => new Response('{}'))
    await createSecretFetch({ hosts: HOSTS, direct })(SECRET)
    expect(direct).toHaveBeenCalledWith(SECRET, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    })
  })

  it("refuses any host but the secret's", async () => {
    const userHost = vi.fn(async () => new Response('{}'))
    const fetch = createSecretFetch({ hosts: HOSTS, userHost })
    for (const url of [
      'https://evil.example/secret.json',
      'http://raw.githubusercontent.com/x',
      'https://raw.githubusercontent.com.evil.example/x',
    ]) {
      const error = await fetch(url).catch((e: unknown) => e)
      expect(isFxmError(error, 'Unsupported')).toBe(true)
    }
    expect(userHost).not.toHaveBeenCalled()
    const nowhere = await createSecretFetch({ hosts: HOSTS })(SECRET).catch((e: unknown) => e)
    expect(isFxmError(nowhere, 'Unsupported')).toBe(true)
  })
})

describe('the choice', () => {
  it('is off by default, and stores only itself', () => {
    const choice = createAccountChoice()
    expect(choice.getState().optedIn).toBe(false)
    choice.getState().setOptedIn(true)
    expect(JSON.parse(localStorage.getItem(SPOTIFY_ACCOUNT_STORAGE_KEY) ?? 'null')).toEqual({
      state: { optedIn: true },
      version: 1,
    })
  })

  it('reads damaged data as off', async () => {
    localStorage.setItem(SPOTIFY_ACCOUNT_STORAGE_KEY, '{"state":{"optedIn":"yes"},"version":1}')
    const choice = createAccountChoice()
    await choice.persist.rehydrate()
    expect(choice.getState().optedIn).toBe(false)
  })
})
