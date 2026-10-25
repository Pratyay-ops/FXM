import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { packageVersion } from '../src/manifest.ts'

describe('package.json', () => {
  it('has a version both browsers accept, which the build writes into the manifests', () => {
    const pkg: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    )
    expect(packageVersion(pkg)).toMatch(/^\d+(\.\d+){0,3}$/)
  })
})
