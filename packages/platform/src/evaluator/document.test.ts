import { describe, expect, it, vi } from 'vitest'
import {
  documentOrigin,
  type EvaluatorMailbox,
  MAILBOX_GLOBAL,
  startEvaluatorDocument,
} from './document'
import { isTrustedParentMessage } from './messages'
import { EVALUATOR_CHANNEL, EVALUATOR_PROTOCOL_VERSION } from './protocol'

const FXM = 'https://fxm-music.pages.dev'
const EVAL_URL = `${FXM}/sandbox/eval.html`

/** A framed document's window, with a parent that records what it was sent. */
function framedWindow(href = EVAL_URL) {
  const posted: Array<{ message: unknown; origin: string }> = []
  const listeners: Array<(event: MessageEvent) => void> = []
  const parent = {
    postMessage(message: unknown, origin: string) {
      posted.push({ message, origin })
    },
  }
  const window = {
    parent,
    location: { href },
    addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
      listeners.push(listener)
    },
  }
  const dispatch = (data: unknown, origin = FXM, source: unknown = parent) => {
    for (const listener of listeners) listener({ data, origin, source } as MessageEvent)
  }
  return { window, parent, posted, dispatch }
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
    it('announces itself to the FXM origin and answers its parent there', async () => {
      const { window, posted, dispatch } = framedWindow()
      expect(startEvaluatorDocument(window)).toBe('framed')
      expect(posted[0]).toEqual({
        message: {
          channel: EVALUATOR_CHANNEL,
          type: 'ready',
          version: EVALUATOR_PROTOCOL_VERSION,
          origin: FXM,
        },
        origin: FXM,
      })
      dispatch(request(1))
      await settle()
      expect(posted[1]).toEqual({
        message: { channel: EVALUATOR_CHANNEL, id: 1, ok: true, result: 8 },
        origin: FXM,
      })
    })

    it('ignores messages from another origin or another window', async () => {
      const { window, posted, dispatch } = framedWindow()
      startEvaluatorDocument(window)
      dispatch(request(1), 'https://evil.example')
      dispatch(request(2), 'null')
      dispatch(request(3), FXM, {})
      await settle()
      expect(posted).toHaveLength(1)
    })
  })

  describe('the message checks', () => {
    it('accept only the parent, from the origin the document was served from', () => {
      const { window, parent } = framedWindow()
      expect(isTrustedParentMessage({ source: parent, origin: FXM }, window)).toBe(true)
      expect(
        isTrustedParentMessage({ source: parent, origin: 'https://other.example' }, window),
      ).toBe(false)
      expect(isTrustedParentMessage({ source: window, origin: FXM }, window)).toBe(false)
      const top = { parent: undefined as unknown, location: { href: EVAL_URL } }
      top.parent = top
      expect(isTrustedParentMessage({ source: top, origin: FXM }, top)).toBe(false)
      const opaque = framedWindow('about:blank')
      expect(isTrustedParentMessage({ source: opaque.parent, origin: 'null' }, opaque.window)).toBe(
        false,
      )
    })
  })

  describe('top-level, with a mailbox', () => {
    function topWindow(href = 'fxm-eval://localhost/eval.html') {
      const window: Record<string, unknown> & {
        parent: unknown
        location: { href: string }
        addEventListener: () => void
      } = { parent: undefined, location: { href }, addEventListener: vi.fn() }
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
