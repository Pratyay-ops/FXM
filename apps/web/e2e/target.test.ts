// @vitest-environment node
// Which server the browser tests take the one they run against for: no browser, no DOM.
import { describe, expect, it } from 'vitest'
import { target } from './target'

describe('target', () => {
  it('is vite preview, which playwright.config.ts builds and serves, by default', () => {
    expect(target({})).toBe('preview')
    expect(target({ FXM_E2E_BASE_URL: '' })).toBe('preview')
  })

  it("is make dist's folder for a server that is up already (FXM_E2E_BASE_URL)", () => {
    expect(target({ FXM_E2E_BASE_URL: 'http://127.0.0.1:5800/app/' })).toBe('pages')
  })

  it('is what FXM_E2E_TARGET names, which the flows set', () => {
    expect(target({ FXM_E2E_TARGET: 'pages' })).toBe('pages')
    expect(
      target({ FXM_E2E_TARGET: 'preview', FXM_E2E_BASE_URL: 'http://localhost:4173/app/' }),
    ).toBe('preview')
  })

  it('refuses a target it does not know', () => {
    expect(() => target({ FXM_E2E_TARGET: 'dist' })).toThrow('use pages or preview')
  })
})
