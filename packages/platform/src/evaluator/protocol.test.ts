import { describe, expect, it } from 'vitest'
import {
  EVALUATOR_CHANNEL,
  isJsonValue,
  MAX_CONTENT_BINDINGS,
  parseEvaluatorHello,
  parseEvaluatorRequest,
  parseEvaluatorResponse,
  requestIdOf,
} from './protocol'

const base = { channel: EVALUATOR_CHANNEL, id: 1 }

describe('the evaluator protocol', () => {
  it('reads every well-formed request', () => {
    const requests = [
      { ...base, method: 'evaluate', params: { source: 'return 1', args: { a: [1, 'b', null] } } },
      { ...base, method: 'define', params: { key: 'player:abc', source: 'return 1' } },
      { ...base, method: 'invoke', params: { key: 'player:abc', args: [] } },
      {
        ...base,
        method: 'botguard.snapshot',
        params: { interpreter: 'x', program: 'y', globalName: 'vm', pageConfig: { EVENT_ID: 'e' } },
      },
      { ...base, method: 'botguard.mint', params: { integrityToken: 't', contentBindings: ['v'] } },
    ]
    for (const request of requests) expect(parseEvaluatorRequest(request)).toEqual(request)
  })

  it('refuses malformed requests but still finds their id', () => {
    const malformed = [
      { ...base, method: 'evaluate', params: { source: '', args: null } },
      { ...base, method: 'evaluate', params: { source: 'x', args: () => 1 } },
      { ...base, method: 'define', params: { key: 'has space', source: 'x' } },
      { ...base, method: 'invoke', params: { key: 'k' } },
      {
        ...base,
        method: 'botguard.snapshot',
        params: { interpreter: 'x', program: 'y', globalName: '1vm' },
      },
      {
        ...base,
        method: 'botguard.snapshot',
        params: { interpreter: 'x', program: 'y', globalName: 'vm', timeoutMs: 0 },
      },
      { ...base, method: 'botguard.mint', params: { integrityToken: 't', contentBindings: [] } },
      {
        ...base,
        method: 'botguard.mint',
        params: {
          integrityToken: 't',
          contentBindings: Array.from({ length: MAX_CONTENT_BINDINGS + 1 }, () => 'v'),
        },
      },
      { ...base, method: 'unknown', params: {} },
    ]
    for (const request of malformed) {
      expect(parseEvaluatorRequest(request), JSON.stringify(request)).toBeUndefined()
      expect(requestIdOf(request)).toBe(1)
    }
    expect(requestIdOf({ channel: 'other', id: 1 })).toBeUndefined()
    expect(requestIdOf({ ...base, id: -1 })).toBeUndefined()
  })

  it('reads responses and hellos, and refuses anything else', () => {
    expect(parseEvaluatorResponse({ ...base, ok: true, result: [1] })).toEqual({
      ...base,
      ok: true,
      result: [1],
    })
    expect(
      parseEvaluatorResponse({ ...base, ok: false, error: { code: 'timeout', message: 'slow' } }),
    ).toEqual({ ...base, ok: false, error: { code: 'timeout', message: 'slow' } })
    expect(
      parseEvaluatorResponse({ ...base, ok: false, error: { code: 'made-up', message: '' } }),
    ).toBeUndefined()
    expect(parseEvaluatorResponse({ ...base, ok: 'yes' })).toBeUndefined()
    expect(
      parseEvaluatorHello({
        channel: EVALUATOR_CHANNEL,
        type: 'ready',
        version: 1,
        origin: 'about:',
      }),
    ).toEqual({ channel: EVALUATOR_CHANNEL, type: 'ready', version: 1, origin: 'about:' })
    expect(
      parseEvaluatorHello({ channel: EVALUATOR_CHANNEL, type: 'ready', version: 1 }),
    ).toBeUndefined()
  })

  it('accepts only plain JSON values', () => {
    expect(isJsonValue({ a: [1, 'x', true, null, { b: Object.create(null) }] })).toBe(true)
    expect(isJsonValue(Number.NaN)).toBe(false)
    expect(isJsonValue(undefined)).toBe(false)
    expect(isJsonValue(new Date())).toBe(false)
    expect(isJsonValue(new Uint8Array(1))).toBe(false)
    let deep: unknown = 1
    for (let index = 0; index < 70; index += 1) deep = [deep]
    expect(isJsonValue(deep)).toBe(false)
  })
})
