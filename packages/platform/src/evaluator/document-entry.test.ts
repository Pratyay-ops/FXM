import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAILBOX_GLOBAL } from './document'

const FXM = 'https://fxmusic.pages.dev'
const NONCE = '0123456789abcdef0123456789abcdef'

/** Ports the document handed to its parent, closed after each test so that none keeps Node running. */
const ports: MessagePort[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  for (const port of ports.splice(0)) port.close()
})

/**
 * Runs the document's script (`document-entry.ts`) in a window with `origin` as `self.origin`,
 * framed by a parent or on its own, and says what it did.
 */
async function run(options: { framed: boolean; origin: string; href: string }) {
  const posted: unknown[] = []
  const parent = {
    postMessage(message: unknown, _origin: string, transfer: MessagePort[] = []) {
      ports.push(...transfer)
      posted.push(message)
    },
  }
  const window: Record<string, unknown> = { location: { href: options.href } }
  window.parent = options.framed ? parent : window
  vi.stubGlobal('window', window)
  vi.stubGlobal('self', { origin: options.origin })
  await import('./document-entry')
  return { posted, mailbox: Object.hasOwn(window, MAILBOX_GLOBAL) }
}

describe('the evaluator document’s script', () => {
  it('starts framed where its sandbox policy made it opaque', async () => {
    const href = `${FXM}/sandbox/eval.html#${NONCE}`
    expect(await run({ framed: true, origin: 'null', href })).toEqual({
      posted: [expect.objectContaining({ type: 'ready', nonce: NONCE })],
      mailbox: false,
    })
  })

  it('does nothing framed at an origin that is not opaque, such as an encoded path on Pages', async () => {
    const href = `${FXM}/sandbox/eval%2Ehtml#${NONCE}`
    expect(await run({ framed: true, origin: FXM, href })).toEqual({ posted: [], mailbox: false })
  })

  it('opens its mailbox on its own, as in the Android app at YouTube’s origin', async () => {
    const youtube = 'https://www.youtube.com'
    expect(await run({ framed: false, origin: youtube, href: `${youtube}/` })).toEqual({
      posted: [],
      mailbox: true,
    })
  })
})
