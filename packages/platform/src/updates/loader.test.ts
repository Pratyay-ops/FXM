import { isFxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { utf8 } from './encoding.ts'
import { importModuleFromBytes } from './loader.ts'
import { nodeModuleImporter } from './testing.ts'

describe('importModuleFromBytes', () => {
  it('imports exactly the given bytes from a blob: URL and returns the exports', async () => {
    const urls: string[] = []
    const namespace = await importModuleFromBytes(
      utf8('export const version = 7; export default "fxm"'),
      {
        importer: (url) => {
          urls.push(url)
          return nodeModuleImporter(url)
        },
      },
    )
    expect(namespace.version).toBe(7)
    expect(namespace.default).toBe('fxm')
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatch(/^blob:/)
  })

  it('revokes the blob: URL once the import settles, also after a failure', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    try {
      await importModuleFromBytes(utf8('export {}'), { importer: nodeModuleImporter })
      await expect(
        importModuleFromBytes(utf8('export {}'), {
          importer: () => Promise.reject(new TypeError('blocked by CSP')),
        }),
      ).rejects.toThrow()
      expect(revoke).toHaveBeenCalledTimes(2)
    } finally {
      revoke.mockRestore()
    }
  })

  it('turns a module that fails to load or evaluate into a Parse error', async () => {
    const thrown = await importModuleFromBytes(utf8('throw new Error("broken")'), {
      importer: nodeModuleImporter,
    }).catch((error: unknown) => error)
    expect(isFxmError(thrown, 'Parse')).toBe(true)
    const syntax = await importModuleFromBytes(utf8('export const = 1'), {
      importer: nodeModuleImporter,
    }).catch((error: unknown) => error)
    expect(isFxmError(syntax, 'Parse')).toBe(true)
  })

  it('refuses an importer result that is not a module namespace', async () => {
    const result = await importModuleFromBytes(utf8('export {}'), {
      importer: async () => null,
    }).catch((error: unknown) => error)
    expect(isFxmError(result, 'Parse')).toBe(true)
  })

  it('needs blob: URLs', async () => {
    const create = URL.createObjectURL
    try {
      ;(URL as { createObjectURL?: unknown }).createObjectURL = undefined
      const result = await importModuleFromBytes(utf8('export {}')).catch((error: unknown) => error)
      expect(isFxmError(result, 'Unsupported')).toBe(true)
    } finally {
      URL.createObjectURL = create
    }
  })
})
