import { describe, expect, it, vi } from 'vitest'
import { APP_BASE } from '../../../pwa/base'
import { isInstallableWebApp } from './web-app'

describe('isInstallableWebApp', () => {
  it('is the web build, served from /app/ with the manifest and the service worker', () => {
    expect(APP_BASE).toBe('/app/')
    expect(isInstallableWebApp('/app/')).toBe(true)
  })

  it('is not the Android or desktop build, which use base /', () => {
    expect(isInstallableWebApp('/')).toBe(false)
  })

  it("reads the build's base", () => {
    vi.stubEnv('BASE_URL', '/')
    expect(isInstallableWebApp()).toBe(false)
    vi.stubEnv('BASE_URL', '/app/')
    expect(isInstallableWebApp()).toBe(true)
  })
})
