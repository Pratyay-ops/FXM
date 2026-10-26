import { describe, expect, it, vi } from 'vitest'
import { declaresLoginDataCollection, LOGIN_DATA_COLLECTION, loginConsent } from './consent.ts'
import { buildManifest } from './manifest.ts'
import type { PermissionsRequest, WebExtApi } from './webext.ts'

const firefox = buildManifest({ browser: 'firefox', version: '1.2.3', dev: false })
const chromium = buildManifest({ browser: 'chromium', version: '1.2.3', dev: false })
const REQUEST = { data_collection: ['authenticationInfo'] }

function fakeApi(manifest: unknown, granted = false, withPermissions = true) {
  let consent = granted
  const permissions = {
    contains: vi.fn(async (_: PermissionsRequest) => consent),
    request: vi.fn(async (_: PermissionsRequest) => {
      consent = true
      return true
    }),
    remove: vi.fn(async (_: PermissionsRequest) => {
      consent = false
      return true
    }),
  }
  const api = {
    runtime: { getManifest: () => manifest } as unknown as WebExtApi['runtime'],
    ...(withPermissions ? { permissions } : {}),
  }
  return { api, permissions }
}

describe('declaresLoginDataCollection', () => {
  it('finds the optional authentication information in the Firefox manifest only', () => {
    expect(LOGIN_DATA_COLLECTION).toBe('authenticationInfo')
    expect(declaresLoginDataCollection(firefox)).toBe(true)
    expect(declaresLoginDataCollection(chromium)).toBe(false)
    expect(declaresLoginDataCollection(null)).toBe(false)
  })
})

describe('loginConsent in Firefox', () => {
  it('asks Firefox for authentication information, and reads and returns it', async () => {
    const { api, permissions } = fakeApi(firefox)
    const consent = loginConsent(api)
    expect(consent.needed).toBe(true)
    await expect(consent.granted()).resolves.toBe(false)
    await expect(consent.request()).resolves.toBe(true)
    await expect(consent.granted()).resolves.toBe(true)
    await consent.release()
    await expect(consent.granted()).resolves.toBe(false)
    expect(permissions.request).toHaveBeenCalledWith(REQUEST)
    expect(permissions.contains).toHaveBeenCalledWith(REQUEST)
    expect(permissions.remove).toHaveBeenCalledWith(REQUEST)
  })

  it('asks synchronously, while the click that turned the login on still counts', () => {
    const { api, permissions } = fakeApi(firefox)
    void loginConsent(api).request()
    expect(permissions.request).toHaveBeenCalledOnce()
  })

  it('keeps the login off when the browser has no permissions API to ask with', async () => {
    const { api } = fakeApi(firefox, false, false)
    const consent = loginConsent(api)
    await expect(consent.granted()).resolves.toBe(false)
    await expect(consent.request()).resolves.toBe(false)
  })
})

describe('loginConsent in Chromium', () => {
  it('needs no consent, so it never asks, and the toggle alone decides', async () => {
    const { api, permissions } = fakeApi(chromium)
    const consent = loginConsent(api)
    expect(consent.needed).toBe(false)
    await expect(consent.granted()).resolves.toBe(true)
    await expect(consent.request()).resolves.toBe(true)
    await consent.release()
    expect(permissions.contains).not.toHaveBeenCalled()
    expect(permissions.request).not.toHaveBeenCalled()
    expect(permissions.remove).not.toHaveBeenCalled()
  })
})
