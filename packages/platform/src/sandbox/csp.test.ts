import { describe, expect, it } from 'vitest'
import {
  inlineScripts,
  SANDBOX_CONNECT_SOURCES,
  sandboxDocumentHeader,
  sandboxDocumentPolicy,
  sha256Source,
} from './csp'

const HASH = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"

describe('sandboxDocumentPolicy', () => {
  it('is the policy of the plan’s header table', () => {
    expect(sandboxDocumentPolicy('innertube', [HASH])).toBe(
      `sandbox allow-scripts; default-src 'none'; script-src ${HASH}; connect-src https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com; base-uri 'none'; form-action 'none'`,
    )
    expect(sandboxDocumentPolicy('userhost', [HASH])).toBe(
      `sandbox allow-scripts; default-src 'none'; script-src ${HASH}; connect-src https:; base-uri 'none'; form-action 'none'`,
    )
  })

  it('leaves `sandbox` out of the copy inside the document, and frame-ancestors out of both', () => {
    const meta = sandboxDocumentPolicy('innertube', [HASH, HASH], { sandbox: false })
    expect(meta).toBe(
      `default-src 'none'; script-src ${HASH} ${HASH}; connect-src ${SANDBOX_CONNECT_SOURCES.innertube.join(' ')}; base-uri 'none'; form-action 'none'`,
    )
    expect(meta).not.toContain('frame-ancestors')
  })

  it('allows scripts by hash only', () => {
    expect(() => sandboxDocumentPolicy('innertube', [])).toThrow(/needs its script/)
    for (const source of ["'self'", "'unsafe-inline'", "'sha256-a b'", 'sha256-abc', "'nonce-x'"]) {
      expect(() => sandboxDocumentPolicy('userhost', [source])).toThrow(/Not a 'sha256-…' source/)
    }
  })
})

describe('sha256Source', () => {
  it('hashes the text as a browser does, line endings normalized', async () => {
    expect(await sha256Source('')).toBe(HASH)
    expect(await sha256Source('abc')).toBe("'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='")
    expect(await sha256Source('a\r\nb\rc')).toBe(await sha256Source('a\nb\nc'))
    expect(await sha256Source('é')).not.toBe(await sha256Source('e'))
  })
})

describe('inlineScripts', () => {
  it('finds the text of every script without src, in order', () => {
    const html = [
      '<script src="/a.js"></script>',
      '<SCRIPT type="module">one()</SCRIPT >',
      '<script\n  data-x="1">\ntwo()\r\n</script>',
      '<script defer src=/b.js></script>',
      '<script></script>',
    ].join('\n')
    expect(inlineScripts(html)).toEqual(['one()', '\ntwo()\n', ''])
    expect(inlineScripts('<p>no scripts</p>')).toEqual([])
  })
})

describe('sandboxDocumentHeader', () => {
  it('allows each inline script of the document', async () => {
    const html = '<script>a()</script><script src="x.js"></script><script>b()</script>'
    const header = await sandboxDocumentHeader('userhost', html)
    expect(header).toBe(
      sandboxDocumentPolicy('userhost', [await sha256Source('a()'), await sha256Source('b()')]),
    )
    await expect(sandboxDocumentHeader('innertube', '<p></p>')).rejects.toThrow(/needs its script/)
  })
})
