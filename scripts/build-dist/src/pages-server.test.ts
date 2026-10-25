import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchRaw } from './check-headers.ts'
import { createPagesServer, listen, resolvePath } from './pages-server.ts'
import { removeTempDirs, tempDir, writeFiles } from './testing.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
  removeTempDirs()
})

function site(headers: string): string {
  const dir = tempDir()
  writeFiles(dir, {
    'index.html': 'home',
    'privacy.html': 'privacy',
    '404.html': 'site 404',
    'favicon.svg': '<svg/>',
    'app/index.html': 'app',
    'app/404.html': 'app shell',
    'app/assets/a.js': 'js',
    _headers: headers,
  })
  return dir
}

async function serve(dir: string): Promise<URL> {
  const server = createPagesServer(dir)
  servers.push(server)
  return new URL(`http://127.0.0.1:${await listen(server, 0)}`)
}

describe('resolvePath', () => {
  const dir = () => site('')
  it.each([
    ['/', { kind: 'file', status: 200, file: 'index.html' }],
    ['/index.html', { kind: 'redirect', location: '/' }],
    ['/privacy', { kind: 'file', status: 200, file: 'privacy.html' }],
    ['/privacy.html', { kind: 'redirect', location: '/privacy' }],
    ['/privacy/', { kind: 'redirect', location: '/privacy' }],
    ['/app', { kind: 'redirect', location: '/app/' }],
    ['/app/', { kind: 'file', status: 200, file: 'app/index.html' }],
    ['/app/index', { kind: 'redirect', location: '/app/' }],
    ['/app/search/deep', { kind: 'file', status: 404, file: 'app/404.html' }],
    ['/app/assets/a.js', { kind: 'file', status: 200, file: 'app/assets/a.js' }],
    ['/nope', { kind: 'file', status: 404, file: '404.html' }],
    ['/_headers', { kind: 'file', status: 404, file: '404.html' }],
  ])('%s', (path, expected) => {
    const root = dir()
    const got = resolvePath(root, path)
    expect(got.kind === 'file' ? { ...got, file: got.file.slice(root.length + 1) } : got).toEqual(
      expected,
    )
  })
})

describe('createPagesServer', () => {
  it('applies the matching rule to pages, redirects and 404s, over Pages’ defaults', async () => {
    const base = await serve(
      site(
        '/privacy\n  Referrer-Policy: no-referrer\n/privacy.html\n  Referrer-Policy: no-referrer\n/app/*\n  Content-Security-Policy: app\n',
      ),
    )
    const page = await fetchRaw(new URL('/privacy', base))
    expect(page.status).toBe(200)
    expect(page.headers).toContainEqual(['referrer-policy', 'no-referrer'])
    expect(page.headers).toContainEqual(['access-control-allow-origin', '*'])
    const redirect = await fetchRaw(new URL('/privacy.html?x=1', base))
    expect(redirect.status).toBe(308)
    expect(redirect.headers).toContainEqual(['location', '/privacy?x=1'])
    expect(redirect.headers).toContainEqual(['referrer-policy', 'no-referrer'])
    const route = await fetchRaw(new URL('/app/settings', base))
    expect(route.status).toBe(404)
    expect(route.headers).toContainEqual(['content-security-policy', 'app'])
    expect(route.headers).toContainEqual(['cache-control', 'no-store'])
    const unknown = await fetchRaw(new URL('/nope', base))
    expect(unknown.headers).toContainEqual(['referrer-policy', 'strict-origin-when-cross-origin'])
    expect(unknown.headers.some(([name]) => name === 'content-security-policy')).toBe(false)
  })

  it('joins a header that two matching rules set, as Pages does', async () => {
    const base = await serve(
      site('/*\n  Content-Security-Policy: a\n/app/*\n  Content-Security-Policy: b\n'),
    )
    const response = await fetchRaw(new URL('/app/', base))
    expect(response.headers.filter(([name]) => name === 'content-security-policy')).toEqual([
      ['content-security-policy', 'a, b'],
    ])
  })

  it('finds files by the decoded path but matches rules against the path as sent', async () => {
    const base = await serve(site('/privacy\n  Content-Security-Policy: page\n'))
    const encoded = await fetchRaw(new URL('/%70rivacy', base))
    expect(encoded.status).toBe(200)
    expect(encoded.body).toBe('privacy')
    expect(encoded.headers.some(([name]) => name === 'content-security-policy')).toBe(false)
  })

  it('merges repeated slashes before both, as Cloudflare does', async () => {
    const base = await serve(site('/privacy\n  Content-Security-Policy: page\n'))
    const response = await fetchRaw(new URL(`${base.origin}//privacy`))
    expect(response.status).toBe(200)
    expect(response.headers).toContainEqual(['content-security-policy', 'page'])
  })

  it('answers only GET and HEAD', async () => {
    const base = await serve(site(''))
    const response = await fetch(new URL('/', base), { method: 'POST' })
    expect(response.status).toBe(405)
  })
})
