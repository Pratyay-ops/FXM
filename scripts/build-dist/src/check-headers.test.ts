import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDeployment, probesFor, responseProblems } from './check-headers.ts'
import { serializeHeaders } from './headers-file.ts'
import { createPagesServer, listen } from './pages-server.ts'
import { generateRules } from './rules.ts'
import { removeTempDirs, tempDir, writeFiles } from './testing.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
  removeTempDirs()
})

const page = (head = '') =>
  `<!doctype html><html><head><title>t</title>${head}</head><body><h1>t</h1></body></html>`

/** A small composed folder with its generated _headers. */
function composed(): string {
  const dir = tempDir()
  writeFiles(dir, {
    'index.html': page('<style>h1{}</style>'),
    'privacy.html': page(),
    'favicon.svg': '<svg/>',
    'app/index.html': page('<script>theme()</script>'),
    'app/404.html': page('<script>theme()</script>'),
    'app/assets/a.js': '1',
    'sandbox/innertube.html': page('<script>inner()</script>'),
  })
  writeFileSync(join(dir, '_headers'), serializeHeaders(generateRules(dir)))
  return dir
}

async function serve(dir: string): Promise<URL> {
  const server = createPagesServer(dir)
  servers.push(server)
  return new URL(`http://127.0.0.1:${await listen(server, 0)}/`)
}

describe('probesFor', () => {
  it('probes each canonical path, each .html path that redirects, and a client-side route', () => {
    const probes = probesFor(composed()).map(({ path, status, location }) => [
      path,
      status,
      location,
    ])
    expect(probes).toEqual([
      ['/app/404', 200, undefined],
      ['/app/404.html', 308, '/app/404'],
      ['/app/assets/a.js', 200, undefined],
      ['/app/', 200, undefined],
      ['/app/index.html', 308, '/app/'],
      ['/favicon.svg', 200, undefined],
      ['/', 200, undefined],
      ['/index.html', 308, '/'],
      ['/privacy', 200, undefined],
      ['/privacy.html', 308, '/privacy'],
      ['/sandbox/innertube', 200, undefined],
      ['/sandbox/innertube.html', 308, '/sandbox/innertube'],
      ['/app/__fxm-route-check__/deep/link', 404, undefined],
    ])
  })
})

describe('checkDeployment', () => {
  it('passes when the host applies exactly the generated rules', async () => {
    const dir = composed()
    expect(await checkDeployment(await serve(dir), probesFor(dir))).toEqual([])
  })

  it('catches a policy joined from two rules, a missing header and a wrong status', async () => {
    const dir = composed()
    const deployed = tempDir()
    cpSync(dir, deployed, { recursive: true })
    const headers = readFileSync(join(dir, '_headers'), 'utf8')
    // A catch-all rule overlapping every other one, and the policy missing from /favicon.svg.
    const tampered = `/*\n  Content-Security-Policy: default-src 'none'\n\n${headers.replace(/(\/favicon\.svg\n)\s+Content-Security-Policy:.*\n/, '$1')}`
    writeFileSync(join(deployed, '_headers'), tampered)
    const problems = await checkDeployment(
      await serve(deployed),
      probesFor(dir).filter((probe) => ['/', '/favicon.svg'].includes(probe.path)),
    )
    expect(problems.some((problem) => problem.startsWith('/: content-security-policy is'))).toBe(
      true,
    )
    expect(problems).toContain(
      '/: Content-Security-Policy: more than one policy (the value contains a comma)',
    )
    expect(
      problems.some((problem) => problem.startsWith('/favicon.svg: content-security-policy is')),
    ).toBe(true)
  })

  it('reports a host it cannot reach, after retrying', async () => {
    const dir = composed()
    const probes = probesFor(dir).slice(0, 1)
    const problems = await checkDeployment(new URL('http://127.0.0.1:9/'), probes, { retries: 0 })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^\/app\/404: /)
  })
})

describe('responseProblems', () => {
  const probe = probesFor(composed()).find((candidate) => candidate.path === '/sandbox/innertube')
  if (!probe) throw new Error('no sandbox probe')
  const base = new URL('https://fxm-music.pages.dev/')
  const headers = [...probe.rule.headers] as [string, string][]

  it('accepts exactly the expected headers', () => {
    expect(responseProblems(probe, { status: 200, headers }, base)).toEqual([])
  })

  it('counts repeated header lines, which a joined value would hide', () => {
    const doubled = [...headers, ['referrer-policy', 'no-referrer']] as [string, string][]
    expect(responseProblems(probe, { status: 200, headers: doubled }, base)).toEqual([
      '/sandbox/innertube: 2 referrer-policy headers, expected exactly one',
    ])
  })

  it("insists on the sandbox and allows 'unsafe-eval' only in the evaluator", () => {
    const loose = headers.map(([name, value]) =>
      name === 'content-security-policy'
        ? [name, "default-src 'none'; script-src 'unsafe-eval'"]
        : [name, value],
    ) as [string, string][]
    const fake = { ...probe, rule: { ...probe.rule, headers: new Map(loose) } }
    expect(responseProblems(fake, { status: 200, headers: loose }, base)).toEqual([
      '/sandbox/innertube: a sandbox document without "sandbox allow-scripts"',
      "/sandbox/innertube: 'unsafe-eval' outside the evaluator document",
    ])
  })

  it('checks where a redirect points', () => {
    const redirect = probesFor(composed()).find((candidate) => candidate.path === '/privacy.html')
    if (!redirect) throw new Error('no redirect probe')
    const response = {
      status: 308,
      headers: [...redirect.rule.headers, ['location', '/elsewhere']] as [string, string][],
    }
    expect(responseProblems(redirect, response, base)).toEqual([
      '/privacy.html: redirects to /elsewhere, expected /privacy',
    ])
  })
})
