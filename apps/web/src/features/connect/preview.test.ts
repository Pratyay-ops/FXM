import { CONNECT_SEEN_KEY, memoryStorage } from '@fxm/platform'
import { installFakeConnect } from '@fxm/platform/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { previewConnect } from './preview'
import { closeTestPages, openTestPage } from './testing'

afterEach(() => closeTestPages())

describe('previewConnect', () => {
  it('answers with what FXM Connect says', async () => {
    const window = openTestPage()
    const connect = installFakeConnect(window, { version: '0.1.0' })
    expect(await previewConnect({ window, storage: memoryStorage() })).toMatchObject({
      state: 'present',
      version: '0.1.0',
    })
    expect(connect.pings).toBe(1)
  })

  it('knows an FXM Connect seen here before, and one that never was', async () => {
    const storage = memoryStorage()
    expect(await previewConnect({ window: openTestPage(), storage })).toMatchObject({
      state: 'absent',
    })
    storage.setItem(CONNECT_SEEN_KEY, JSON.stringify({ version: '0.1.0', at: 1 }))
    expect(await previewConnect({ window: openTestPage(), storage })).toMatchObject({
      state: 'missing',
      lastSeenVersion: '0.1.0',
    })
  })

  it('stops listening once it has the answer', async () => {
    const window = openTestPage()
    const connect = installFakeConnect(window, { version: '0.1.0' })
    await previewConnect({ window, storage: memoryStorage() })
    // A later marker change wakes no detection of the finished preview.
    window.document.documentElement.setAttribute('data-fxm-connect', '0.2.0')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(connect.pings).toBe(1)
  })
})
