import { FxmError, isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { isTransportError, TransportError } from '../errors'
import {
  isSandboxError,
  isSandboxErrorCode,
  isSandboxRefusalCode,
  SANDBOX_ERROR_CODES,
  SandboxFailedError,
  SandboxRefusedError,
  sandboxError,
} from './errors'

describe('sandboxError', () => {
  it('maps every sandbox code to a refusal or a failure', () => {
    const kinds = Object.fromEntries(
      SANDBOX_ERROR_CODES.map((code) => {
        const error = sandboxError(code)
        return [
          code,
          isTransportError(error) ? `TransportError ${error.reason}` : `FxmError ${error.code}`,
        ]
      }),
    )
    expect(kinds).toEqual({
      'bad-request': 'TransportError bad-request',
      'forbidden-host': 'TransportError bad-request',
      'forbidden-path': 'TransportError bad-request',
      'forbidden-method': 'TransportError bad-request',
      'forbidden-header': 'TransportError bad-request',
      preflight: 'TransportError bad-request',
      'request-too-large': 'TransportError bad-request',
      redirect: 'TransportError redirect',
      'too-large': 'FxmError Parse',
      timeout: 'FxmError Network',
      network: 'FxmError Network',
    })
  })

  it('treats codes it does not know as network failures', () => {
    const error = sandboxError('quota')
    expect(error).toBeInstanceOf(SandboxFailedError)
    expect(isFxmError(error, 'Network')).toBe(true)
    expect(error.sandboxCode).toBe('quota')
    expect(error.message).toContain('quota')
  })
})

describe('SandboxRefusedError', () => {
  it('is a TransportError that keeps the sandbox code, the message and the cause', () => {
    const cause = new Error('checked')
    const error = new SandboxRefusedError('preflight', 'X-Goog-Visitor-Id needs one', { cause })
    expect(error).toBeInstanceOf(TransportError)
    expect(error).toBeInstanceOf(FxmError)
    expect([error.name, error.code, error.reason, error.sandboxCode]).toEqual([
      'FxmError',
      'Unsupported',
      'bad-request',
      'preflight',
    ])
    expect(error.message).toBe('X-Goog-Visitor-Id needs one')
    expect(error.cause).toBe(cause)
    expect(new SandboxRefusedError('request-too-large').message).toMatch(/request body/)
    expect('cause' in new SandboxRefusedError('redirect')).toBe(false)
  })
})

describe('SandboxFailedError', () => {
  it('keeps the sandbox code, the message and the cause', () => {
    const cause = new TypeError('Failed to fetch')
    const error = new SandboxFailedError('network', 'InnerTube did not answer', { cause })
    expect(error).toBeInstanceOf(FxmError)
    expect(error).not.toBeInstanceOf(TransportError)
    expect([error.name, error.code, error.sandboxCode]).toEqual(['FxmError', 'Network', 'network'])
    expect(error.message).toBe('InnerTube did not answer')
    expect(error.cause).toBe(cause)
    expect(new SandboxFailedError('too-large').code).toBe('Parse')
    expect(new SandboxFailedError('timeout').message).toMatch(/in time/)
    expect('cause' in new SandboxFailedError('timeout')).toBe(false)
    expect(isTransportError(new SandboxFailedError('network'))).toBe(false)
  })
})

describe('isSandboxError and the code checks', () => {
  it('recognize sandbox errors, also from another copy of this module', () => {
    expect(isSandboxError(new SandboxFailedError('timeout'))).toBe(true)
    expect(isSandboxError(new SandboxFailedError('timeout'), 'timeout')).toBe(true)
    expect(isSandboxError(new SandboxFailedError('timeout'), 'network')).toBe(false)
    expect(isSandboxError(new SandboxRefusedError('preflight'), 'preflight')).toBe(true)
    const copy = Object.assign(new Error('x'), {
      name: 'FxmError',
      code: 'Unsupported',
      reason: 'bad-request',
      sandboxCode: 'preflight',
    })
    expect(isSandboxError(copy, 'preflight')).toBe(true)
    expect(isTransportError(copy, 'bad-request')).toBe(true)
    expect(isSandboxError(new FxmError('Network', 'x'))).toBe(false)
    expect(isSandboxError(new TransportError('bad-request', 'x'))).toBe(false)
    expect(isSandboxError({ name: 'FxmError', code: 'Network', sandboxCode: 'timeout' })).toBe(
      false,
    )
    expect(isSandboxError(undefined)).toBe(false)
  })

  it('know the codes', () => {
    expect(SANDBOX_ERROR_CODES.every(isSandboxErrorCode)).toBe(true)
    expect(SANDBOX_ERROR_CODES.filter(isSandboxRefusalCode)).toEqual([
      'bad-request',
      'forbidden-host',
      'forbidden-path',
      'forbidden-method',
      'forbidden-header',
      'preflight',
      'request-too-large',
      'redirect',
    ])
    expect(isSandboxErrorCode('quota')).toBe(false)
    expect(isSandboxErrorCode(undefined)).toBe(false)
    expect(isSandboxRefusalCode('toString')).toBe(false)
  })
})
