import { afterEach, describe, expect, it } from 'vitest'
import {
  documentOrigin,
  type EvaluatorMailbox,
  MAILBOX_GLOBAL,
  startEvaluatorDocument,
} from './document'
import { trustedParentOrigin } from './messages'
import { EVALUATOR_CHANNEL, EVALUATOR_PROTOCOL_VERSION } from './protocol'

const FXM = 'https://fxmusic.pages.dev'
const NONCE = '0123456789abcdef0123456789abcdef'
const EVAL_URL = `${FXM}/sandbox/eval.html#${NONCE}`

/** Ports the tests opened, closed after each test so that none keeps Node running. */
const ports: MessagePort[] = []

afterEach(() => {
  for (const port of ports.splice(0)) port.close()
})

/** A framed document's window, with a parent that records what it was sent. */
function framedWindow(href = EVAL_URL) {
  const posted: Array<{ message: unknown; origin: string; transfer: MessagePort[] }> = []
  const parent = {
    postMessage(message: unknown, origin: string, transfer: MessagePort[] = []) {
      ports.push(...transfer)
      posted.push({ message, origin, transfer })
    },
  }
  return { window: { parent, location: { href } }, parent, posted }
}

/** Sends `message` on `port` and resolves with the next answer on it. */
function exchange(port: MessagePort, message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    port.onmessage = (event: MessageEvent) => resolve(event.data)
    port.postMessage(message)
  })
}

/** Lets the runtime's promise chains finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const request = (id: number, source = 'return args * 2', args: unknown = 4) => ({
  channel: EVALUATOR_CHANNEL,
  id,
  method: 'evaluate',
  params: { source, args },
})

describe('the evaluator document', () => {
  it('names custom schemes and plain origins alike', () => {
    expect(documentOrigin(EVAL_URL)).toBe(FXM)
    expect(documentOrigin('fxm-eval://localhost/eval.html')).toBe('fxm-eval://localhost')
    expect(documentOrigin('https://www.youtube.com/')).toBe('https://www.youtube.com')
    expect(documentOrigin('about:blank')).toBe('about:')
  })

  describe('framed', () => {
    it('announces itself with its nonce and a channel, to the FXM origin only', () => {
      const { window, posted } = framedWindow()
      expect(startEvaluatorDocument(window)).toBe('framed')
      expect(posted).toHaveLength(1)
      expect(posted[0]?.message).toEqual({
        channel: EVALUATOR_CHANNEL,
        type: 'ready',
        version: EVALUATOR_PROTOCOL_VERSION,
        origin: FXM,
        nonce: NONCE,
      })
      expect(posted[0]?.origin).toBe(FXM)
      expect(posted[0]?.transfer).toHaveLength(1)
    })

    it('answers requests on its channel', async () => {
      const { window, posted } = framedWindow()
      startEvaluatorDocument(window)
      const port = posted[0]?.transfer[0] as MessagePort
      expect(await exchange(port, request(1))).toEqual({
        channel: EVALUATOR_CHANNEL,
        id: 1,
        ok: true,
        result: 8,
      })
      expect(await exchange(port, { channel: EVALUATOR_CHANNEL, id: 2, method: 'nope' })).toEqual({
        channel: EVALUATOR_CHANNEL,
        id: 2,
        ok: false,
        error: { code: 'bad-request', message: 'The request is malformed' },
      })
    })

    it('leaves out a nonce its URL does not carry', () => {
      for (const href of [`${FXM}/sandbox/eval.html`, `${FXM}/sandbox/eval.html#short`]) {
        const { window, posted } = framedWindow(href)
        startEvaluatorDocument(window)
        expect(posted[0]?.message).not.toHaveProperty('nonce')
      }
    })

    it('talks to the origin it was served from', () => {
      expect(trustedParentOrigin({ parent: {}, location: { href: EVAL_URL } })).toBe(FXM)
      expect(
        trustedParentOrigin({
          parent: {},
          location: { href: 'http://localhost:6010/sandbox/eval.html' },
        }),
      ).toBe('http://localhost:6010')
    })
  })

  describe('top-level, with a mailbox', () => {
    function topWindow(href = 'fxm-eval://localhost/eval.html') {
      const window: Record<string, unknown> & {
        parent: unknown
        location: { href: string }
      } = { parent: undefined, location: { href } }
      window.parent = window
      return window
    }

    it('exposes a frozen mailbox with its hello', () => {
      const window = topWindow()
      expect(startEvaluatorDocument(window)).toBe('mailbox')
      const mailbox = window[MAILBOX_GLOBAL] as EvaluatorMailbox
      expect(JSON.parse(mailbox.hello)).toEqual({
        channel: EVALUATOR_CHANNEL,
        type: 'ready',
        version: EVALUATOR_PROTOCOL_VERSION,
        origin: 'fxm-eval://localhost',
      })
      expect(Object.isFrozen(mailbox)).toBe(true)
      expect(() => {
        window[MAILBOX_GLOBAL] = {}
      }).toThrow()
    })

    it('takes requests as text and hands out each answer once', async () => {
      const window = topWindow('https://www.youtube.com/')
      startEvaluatorDocument(window)
      const mailbox = window[MAILBOX_GLOBAL] as EvaluatorMailbox
      expect(mailbox.receive(JSON.stringify(request(5)))).toBe('accepted')
      expect(mailbox.take(5)).toBeNull()
      await settle()
      expect(JSON.parse(mailbox.take(5) ?? 'null')).toEqual({
        channel: EVALUATOR_CHANNEL,
        id: 5,
        ok: true,
        result: 8,
      })
      expect(mailbox.take(5)).toBeNull()
    })

    it('refuses text that is no request', () => {
      const window = topWindow()
      startEvaluatorDocument(window)
      const mailbox = window[MAILBOX_GLOBAL] as EvaluatorMailbox
      expect(mailbox.receive('not json')).toBe('refused')
      expect(mailbox.receive(JSON.stringify({ hello: 1 }))).toBe('refused')
    })
  })
})
