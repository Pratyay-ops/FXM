import { isFxmError } from '@fxm/core'
import { describe, expect, it, vi } from 'vitest'
import { codeArtifact, jsonArtifact } from './artifact.ts'
import { utf8 } from './encoding.ts'
import { DEFAULT_CODE_MAX_BYTES, DEFAULT_JSON_MAX_BYTES, type UpdateStatement } from './format.ts'
import { nodeModuleImporter } from './testing.ts'

const STATEMENT: UpdateStatement = {
  kind: 'test',
  version: 2,
  file: 'test.json',
  size: 0,
  sha256: '0'.repeat(64),
  signedAt: new Date(0).toISOString(),
}

describe('jsonArtifact', () => {
  it('parses the bytes as JSON and hands them to accept', async () => {
    const accept = vi.fn((json: unknown) => ({ parsed: json }))
    const activate = vi.fn()
    const useBundled = vi.fn()
    const artifact = jsonArtifact({
      kind: 'test',
      file: 'test.json',
      bundledVersion: 1,
      accept,
      activate,
      useBundled,
    })
    expect(artifact).toMatchObject({
      executable: false,
      maxBytes: DEFAULT_JSON_MAX_BYTES,
      bundledVersion: 1,
    })
    expect('api' in artifact).toBe(false)
    expect('inUse' in artifact).toBe(false)
    expect('canLoad' in artifact).toBe(false)
    expect(await artifact.load(utf8('{"a":1}'), STATEMENT)).toEqual({ parsed: { a: 1 } })
    expect(accept).toHaveBeenCalledWith({ a: 1 }, STATEMENT)
    artifact.activate({ parsed: 1 } as never, { origin: 'fetched', version: 2 })
    artifact.useBundled()
    expect(activate).toHaveBeenCalledWith({ parsed: 1 }, { origin: 'fetched', version: 2 })
    expect(useBundled).toHaveBeenCalledOnce()
  })

  it('refuses bytes that are not UTF-8 JSON with a Parse error', async () => {
    const artifact = jsonArtifact({
      kind: 'test',
      file: 'test.json',
      bundledVersion: 1,
      maxBytes: 10,
      accept: (json) => json,
      activate: () => {},
      useBundled: () => {},
    })
    expect(artifact.maxBytes).toBe(10)
    for (const bytes of [utf8('{'), new Uint8Array([0xff])]) {
      const error = await Promise.resolve()
        .then(() => artifact.load(bytes, STATEMENT))
        .catch((caught: unknown) => caught)
      expect(isFxmError(error, 'Parse')).toBe(true)
    }
  })
})

describe('the optional hooks', () => {
  it('pass a schema, the version in use and failures through', () => {
    const failures: number[] = []
    const artifact = jsonArtifact({
      kind: 'test',
      file: 'test-2.json',
      api: 2,
      bundledVersion: 1,
      accept: (json: unknown) => json,
      activate: () => {},
      useBundled: () => {},
      inUse: () => ({ version: 7, origin: 'bundled' }),
      watch: (failed) => failed(3, 'broken'),
    })
    expect(artifact.api).toBe(2)
    expect(artifact.inUse?.()).toEqual({ version: 7, origin: 'bundled' })
    artifact.watch?.((version) => failures.push(version))
    expect(failures).toEqual([3])
  })
})

describe('codeArtifact', () => {
  it('imports the verified bytes as a module and hands the exports to accept', async () => {
    const artifact = codeArtifact(
      {
        kind: 'test-module',
        file: 'test-module-1.js',
        api: 1,
        bundledVersion: 1,
        accept: (exports, statement) => ({ value: exports.value, version: statement.version }),
        activate: () => {},
        useBundled: () => {},
      },
      { importer: nodeModuleImporter },
    )
    expect(artifact).toMatchObject({ executable: true, api: 1, maxBytes: DEFAULT_CODE_MAX_BYTES })
    expect(await artifact.load(utf8('export const value = 42'), STATEMENT)).toEqual({
      value: 42,
      version: 2,
    })
  })

  it('finds out once whether the platform can load code, before anything is downloaded', async () => {
    const spec = {
      kind: 'test-module',
      file: 'test-module-1.js',
      api: 1,
      bundledVersion: 1,
      accept: () => 1,
      activate: () => {},
      useBundled: () => {},
    }
    const loading = codeArtifact(spec, { importer: nodeModuleImporter })
    expect(await loading.canLoad?.()).toBe(true)
    // A CSP without blob: in script-src refuses every blob: module, the one-line probe included.
    const importer = vi.fn(() => Promise.reject(new TypeError('Refused by the CSP')))
    const blocked = codeArtifact(spec, { importer })
    expect(await blocked.canLoad?.()).toBe(false)
    expect(await blocked.canLoad?.()).toBe(false)
    expect(importer).toHaveBeenCalledOnce()
  })
})
