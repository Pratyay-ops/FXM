import { describe, expect, it, vi } from 'vitest'
import { type InstallContext, installHint, listenForInstallPrompt, promptInstall } from './install'
import { type InstallChoice, type InstallPromptEvent, usePwaStore } from './pwa-store'

/** A stand-in for Chromium's `beforeinstallprompt` event. */
function installEvent(outcome: InstallChoice['outcome'] = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as InstallPromptEvent
  const prompt = vi.fn(async () => {})
  Object.assign(event, {
    prompt,
    userChoice: Promise.resolve({ outcome, platform: 'web' } satisfies InstallChoice),
  })
  return { event, prompt }
}

describe('listenForInstallPrompt', () => {
  it("keeps the browser's install offer and stops its own banner", () => {
    const stop = listenForInstallPrompt()
    const { event } = installEvent()

    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(usePwaStore.getState().installPrompt).toBe(event)
    stop()
  })

  it('ignores an event that cannot prompt', () => {
    const stop = listenForInstallPrompt()
    window.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }))
    expect(usePwaStore.getState().installPrompt).toBeUndefined()
    stop()
  })

  it('drops the offer once FXM is installed', () => {
    const stop = listenForInstallPrompt()
    window.dispatchEvent(installEvent().event)

    window.dispatchEvent(new Event('appinstalled'))

    expect(usePwaStore.getState().installPrompt).toBeUndefined()
    stop()
  })

  it('stops listening', () => {
    listenForInstallPrompt()()
    window.dispatchEvent(installEvent().event)
    expect(usePwaStore.getState().installPrompt).toBeUndefined()
  })
})

describe('promptInstall', () => {
  it("shows the browser's dialog and reports the answer", async () => {
    const { event, prompt } = installEvent('accepted')
    usePwaStore.setState({ installPrompt: event })

    await expect(promptInstall()).resolves.toBe('accepted')

    expect(prompt).toHaveBeenCalledOnce()
    // An offer works once.
    expect(usePwaStore.getState().installPrompt).toBeUndefined()
  })

  it('reports a dismissed dialog, and one that failed to open', async () => {
    usePwaStore.setState({ installPrompt: installEvent('dismissed').event })
    await expect(promptInstall()).resolves.toBe('dismissed')

    const { event, prompt } = installEvent()
    prompt.mockRejectedValueOnce(new DOMException('No user gesture', 'NotAllowedError'))
    usePwaStore.setState({ installPrompt: event })
    await expect(promptInstall()).resolves.toBe('dismissed')
  })

  it('does nothing without an offer', async () => {
    await expect(promptInstall()).resolves.toBe('unavailable')
  })
})

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1',
  // iPadOS asks for desktop sites with a Mac user agent; only the touch screen tells.
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  macFirefox:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:158.0) Gecko/20100101 Firefox/158.0',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
  android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
}

const context = (overrides: Partial<InstallContext>): InstallContext => ({
  runningAsApp: false,
  canPrompt: false,
  userAgent: UA.windowsEdge,
  maxTouchPoints: 0,
  ...overrides,
})

describe('installHint', () => {
  it.each([
    ['an installed app', context({ runningAsApp: true, canPrompt: true }), 'installed'],
    ['Edge with an offer', context({ canPrompt: true }), 'prompt'],
    [
      'Chrome on Android with an offer',
      context({ userAgent: UA.android, canPrompt: true }),
      'prompt',
    ],
    ['Safari on iPhone', context({ userAgent: UA.iphone, maxTouchPoints: 5 }), 'ios'],
    ['Chrome on iPhone', context({ userAgent: UA.iphoneChrome, maxTouchPoints: 5 }), 'ios'],
    ['Safari on iPad', context({ userAgent: UA.ipad, maxTouchPoints: 5 }), 'ios'],
    ['Safari on a Mac', context({ userAgent: UA.macSafari }), 'mac-safari'],
    ['Chrome on a Mac without an offer', context({ userAgent: UA.macChrome }), 'browser'],
    ['Firefox on a Mac', context({ userAgent: UA.macFirefox }), 'browser'],
    ['Edge without an offer', context({}), 'browser'],
  ] as const)('%s', (_name, input, hint) => {
    expect(installHint(input)).toBe(hint)
  })
})
