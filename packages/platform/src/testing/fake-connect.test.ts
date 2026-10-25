import { Window } from 'happy-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONNECT_MARKER_ATTRIBUTE, type ConnectWindow } from '../connect'
import { flushPromises } from './fake-clock'
import { installFakeConnect } from './fake-connect'

/** Messages travel on happy-dom's real timers, which a busy machine can slow down a lot. */
const PATIENCE = { timeout: 10_000 }

describe('installFakeConnect', () => {
  const pages: { happyDOM: { close(): Promise<void> } }[] = []
  afterEach(async () => {
    await Promise.all(pages.splice(0).map((page) => page.happyDOM.close()))
  })

  function page() {
    const window = new Window({ url: 'https://fxmusic.pages.dev/app/' })
    pages.push(window)
    return window as unknown as ConnectWindow
  }

  it('marks the page, answers pings from it and ignores everything else', async () => {
    const window = page()
    const connect = installFakeConnect(window, { version: '0.3.0', features: ['youtube'] })
    expect(window.document.documentElement.getAttribute(CONNECT_MARKER_ATTRIBUTE)).toBe('0.3.0')
    const replies: unknown[] = []
    const REPLIES = ['fxm-connect:pong', 'fxm-connect:response', 'fxm-connect:error']
    window.addEventListener('message', (event) => {
      if (REPLIES.includes((event.data as { type?: string }).type ?? '')) replies.push(event.data)
    })
    window.postMessage({ type: 'fxm-connect:unknown' }, 'https://fxmusic.pages.dev')
    window.postMessage('not an object', 'https://fxmusic.pages.dev')
    window.postMessage({ type: 'fxm-connect:ping' }, 'https://fxmusic.pages.dev')
    await vi.waitFor(() => expect(replies).toHaveLength(1), PATIENCE)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(replies).toEqual([{ type: 'fxm-connect:pong', version: '0.3.0', features: ['youtube'] }])
    expect(connect.pings).toBe(1)
  })

  it('answers bridge requests, by default with login-disabled', async () => {
    const window = page()
    const connect = installFakeConnect(window)
    const replies: unknown[] = []
    window.addEventListener('message', (event) => {
      const type = (event.data as { type?: string }).type
      if (type === 'fxm-connect:error' || type === 'fxm-connect:response') replies.push(event.data)
    })
    window.postMessage(
      { type: 'fxm-connect:spotify-server-time', id: 1 },
      'https://fxmusic.pages.dev',
    )
    await vi.waitFor(() => expect(replies).toHaveLength(1), PATIENCE)
    expect(replies[0]).toEqual({ type: 'fxm-connect:error', id: 1, code: 'login-disabled' })
    expect(connect.bridgeRequests).toEqual([{ type: 'fxm-connect:spotify-server-time', id: 1 }])
  })

  it('can change what it says, stop answering pings and be removed', async () => {
    const window = page()
    const connect = installFakeConnect(window)
    connect.update({ features: ['spotify'], answerPings: false })
    window.postMessage({ type: 'fxm-connect:ping' }, 'https://fxmusic.pages.dev')
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(connect.pings).toBe(1)
    connect.uninstall()
    expect(window.document.documentElement.getAttribute(CONNECT_MARKER_ATTRIBUTE)).toBeNull()
    window.postMessage({ type: 'fxm-connect:ping' }, 'https://fxmusic.pages.dev')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(connect.pings).toBe(1)
  })
})
