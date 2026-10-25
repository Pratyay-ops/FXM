import { FxmError, isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { isSandboxError, isSandboxErrorCode, SANDBOX_ERROR_CODES, SandboxError } from './errors'

describe('SandboxError', () => {
  it('maps every sandbox code to an FxmError code', () => {
    const codes = Object.fromEntries(
      SANDBOX_ERROR_CODES.map((code) => [code, new SandboxError(code).code]),
    )
    expect(codes).toEqual({
      'bad-request': 'Unsupported',
      'forbidden-host': 'Unsupported',
      'forbidden-path': 'Unsupported',
      'forbidden-method': 'Unsupported',
      'forbidden-header': 'Unsupported',
      preflight: 'Unsupported',
      'too-large': 'Parse',
      timeout: 'Network',
      network: 'Network',
    })
  })

  it('keeps the sandbox code, the message and the cause', () => {
    const cause = new TypeError('Failed to fetch')
    const error = new SandboxError('network', 'InnerTube did not answer', { cause })
    expect(error).toBeInstanceOf(FxmError)
    expect(error.name).toBe('FxmError')
    expect(error.sandboxCode).toBe('network')
    expect(error.message).toBe('InnerTube did not answer')
    expect(error.cause).toBe(cause)
    expect(new SandboxError('preflight').message).toMatch(/preflight/)
    expect('cause' in new SandboxError('timeout')).toBe(false)
  })

  it('treats codes it does not know as network failures', () => {
    const error = new SandboxError('quota')
    expect(isFxmError(error, 'Network')).toBe(true)
    expect(error.sandboxCode).toBe('quota')
    expect(error.message).toContain('quota')
  })
})

describe('isSandboxError and isSandboxErrorCode', () => {
  it('recognize sandbox errors, also from another copy of this module', () => {
    expect(isSandboxError(new SandboxError('timeout'))).toBe(true)
    expect(isSandboxError(new SandboxError('timeout'), 'timeout')).toBe(true)
    expect(isSandboxError(new SandboxError('timeout'), 'network')).toBe(false)
    const copy = Object.assign(new Error('x'), { name: 'FxmError', sandboxCode: 'preflight' })
    expect(isSandboxError(copy, 'preflight')).toBe(true)
    expect(isSandboxError(new FxmError('Network', 'x'))).toBe(false)
    expect(isSandboxError({ name: 'FxmError', sandboxCode: 'timeout' })).toBe(false)
    expect(isSandboxError(undefined)).toBe(false)
  })

  it('know the codes', () => {
    expect(SANDBOX_ERROR_CODES.every(isSandboxErrorCode)).toBe(true)
    expect(isSandboxErrorCode('quota')).toBe(false)
    expect(isSandboxErrorCode(undefined)).toBe(false)
  })
})
