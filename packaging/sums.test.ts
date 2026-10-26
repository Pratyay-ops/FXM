import { describe, expect, it } from 'vitest'
import { parseSums, sumOf } from './sums.ts'

describe('SHA256SUMS', () => {
  const a = 'a'.repeat(64)
  const b = 'B'.repeat(64)

  it('reads sha256sum’s lines, text and binary', () => {
    const sums = parseSums(
      `${a}  fxm-web-0.6.0.zip\n${b} *fxm-desktop-0.6.0-windows-x64-setup.exe\n\n`,
    )
    expect(sums.get('fxm-web-0.6.0.zip')).toBe(a)
    expect(sumOf(sums, 'fxm-desktop-0.6.0-windows-x64-setup.exe')).toBe(b.toLowerCase())
    expect(() => sumOf(sums, 'missing.apk')).toThrow(/has no missing.apk: the release holds/)
  })

  it('refuses lines it can’t read, paths and duplicates', () => {
    expect(() => parseSums('not a sum\n')).toThrow(/line 1/)
    expect(() => parseSums(`${a}  dir/file.zip\n`)).toThrow(/line 1/)
    expect(() => parseSums(`${a}  x.zip\n${a}  x.zip\n`)).toThrow(/twice/)
  })
})
