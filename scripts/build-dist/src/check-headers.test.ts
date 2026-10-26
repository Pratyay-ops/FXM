import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkDeployment,
  type Probe,
  probesFor,
  REWRITE_PROBE_ID,
  responseProblems,
} from './check-headers.ts'
import { serializeHeaders } from './headers-file.ts'
import { createPagesServer, listen } from './pages-server.ts'
import { redirectRules, serializeRedirects } from './redirects.ts'
import { addDocumentPolicies, generateRules, listFiles } from './rules.ts'
import { removeTempDirs, sandboxDocument, tempDir, writeFiles } from './testing.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
  removeTempDirs()
})

const page = (head = '') =>
  `<!doctype html><html><head><title>t</title>${head}</head><body><h1>t</h1></body></html>`

/** A small composed folder: its pages carry their policies, and _headers is written. */
function composed(): string {
  const dir = tempDir()
  writeFiles(dir, {
    'index.html': page('<style>h1{}</style>'),
    'privacy.html': page(),
    'favicon.svg': '<svg/>',
    'app/index.html': page('<script>theme()</script>'),
    'app/404.html': page('<script>theme()</script>'),
    'app/assets/a.js': '1',
    'sandbox/innertube.html': sandboxDocument('innertube.html'),
  })
  const rules = generateRules(dir)
  addDocumentPolicies(dir, rules)
  writeFileSync(join(dir, '_headers'), serializeHeaders(rules))
  return dir
}

/** The same with the embed, whose routes _redirects answers with its page (src/redirects.ts). */
function composedWithEmbed(): string {
  const dir = tempDir()
  writeFiles(dir, {
    'index.html': page(),
    'app/index.html': page(),
    'app/404.html': page(),
    'embed/index.html': page(),
    'embed/404.html': page(),
    'embed/assets/e.js': '1',
  })
  const rules = generateRules(dir)
  addDocumentPolicies(dir, rules)
  writeFileSync(join(dir, '_headers'), serializeHeaders(rules))
  writeFileSync(join(dir, '_redirects'), serializeRedirects(redirectRules(listFiles(dir))))
  return dir
}

async function serve(dir: string): Promise<URL> {
  const server = createPagesServer(dir)
  servers.push(server)
  return new URL(`http://127.0.0.1:${await listen(server, 0)}/`)
}

const ruleOf = (probe: Probe | undefined) => {
  if (!probe?.rule) throw new Error('no rule')
  return probe.rule
}

describe('probesFor', () => {
  it('probes each path a file is served at, a client-side route, and documents at encoded paths', () => {
    const probes = probesFor(composed()).map(({ path, status, location, rule, documentPolicy }) => [
      path,
      status,
      location,
      rule !== undefined,
      documentPolicy !== undefined,
    ])
    expect(probes).toEqual([
      ['/app/404', 200, undefined, true, true],
      ['/app/404.html', 308, '/app/404', true, false],
      ['/app/assets/a.js', 200, undefined, true, false],
      ['/app/', 200, undefined, true, true],
      ['/app/index.html', 308, '/app/', true, false],
      ['/favicon.svg', 200, undefined, true, false],
      ['/', 200, undefined, true, true],
      ['/index.html', 308, '/', true, false],
      ['/privacy', 200, undefined, true, true],
      ['/privacy.html', 308, '/privacy', true, false],
      ['/sandbox/innertube', 200, undefined, true, true],
      ['/sandbox/innertube.html', 308, '/sandbox/innertube', true, false],
      ['/app/__fxm-route-check__/deep/link', 404, undefined, true, true],
      // No rule reaches these: each document's meta elements must do the work.
      ['/%61pp/', 200, undefined, false, true],
      ['/ap%70/', 200, undefined, false, true],
      ['/app%2F', 200, undefined, false, true],
      ['/%70rivacy', 200, undefined, false, true],
      ['/privac%79', 200, undefined, false, true],
      ['/%73andbox/innertube', 200, undefined, false, true],
      ['/sandbo%78/innertube', 200, undefined, false, true],
      ['/sandbox%2Finnertube', 200, undefined, false, true],
      ['/sandbox/%69nnertube', 200, undefined, false, true],
      ['/sandbox/innertub%65', 200, undefined, false, true],
    ])
  })

  it("expects each of the embed's routes to answer 200 with its page and the /embed/* rule", () => {
    const probes = probesFor(composedWithEmbed())
    const routes = probes.filter((probe) => probe.path.includes(REWRITE_PROBE_ID))
    expect(routes.map((probe) => [probe.path, probe.status, probe.rule?.path])).toEqual([
      [`/embed/track/${REWRITE_PROBE_ID}`, 200, '/embed/*'],
      [`/embed/album/${REWRITE_PROBE_ID}`, 200, '/embed/*'],
      [`/embed/playlist/${REWRITE_PROBE_ID}`, 200, '/embed/*'],
    ])
    const embed = probes.find((probe) => probe.path === '/embed/')
    for (const route of routes) {
      expect(route.documentPolicy).toBe(embed?.documentPolicy)
      expect(route.documentPolicy).toBe(route.rule?.headers.get('content-security-policy'))
    }
    // Everything else as before: a path no route names still gets the embed's 404 page, and
    // neither configuration file is a path.
    expect(
      probes.find((probe) => probe.path === '/embed/__fxm-route-check__/deep/link')?.status,
    ).toBe(404)
    expect(probes.find((probe) => probe.path === '/embed/assets/e.js')?.status).toBe(200)
    expect(probes.some((probe) => /^\/_(headers|redirects)$/.test(probe.path))).toBe(false)
  })

  it('asks the site and the apps for no-referrer in their pages, not the sandbox', () => {
    const probes = probesFor(composed())
    const referrer = (path: string) => probes.find((probe) => probe.path === path)?.referrerMeta
    expect(referrer('/privacy')).toBe(true)
    expect(referrer('/%61pp/')).toBe(true)
    expect(referrer('/sandbox/innertube')).toBe(false)
  })
})

describe('checkDeployment', () => {
  it('passes when the host applies exactly the generated rules', async () => {
    const dir = composed()
    expect(await checkDeployment(await serve(dir), probesFor(dir))).toEqual([])
  })

  it("passes the embed's routes where the host applies _redirects, and fails them where not", async () => {
    const dir = composedWithEmbed()
    expect(await checkDeployment(await serve(dir), probesFor(dir))).toEqual([])
    // A host without the rewrites answers the routes with the embed's 404 page.
    const plain = tempDir()
    cpSync(dir, plain, { recursive: true })
    rmSync(join(plain, '_redirects'))
    const problems = await checkDeployment(
      await serve(plain),
      probesFor(dir).filter((probe) => probe.path.startsWith('/embed/track/')),
    )
    expect(problems).toEqual([`/embed/track/${REWRITE_PROBE_ID}: status 404, expected 200`])
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

  it('catches a document without its policy in a meta element, at every path it is served', async () => {
    const dir = composed()
    const deployed = tempDir()
    cpSync(dir, deployed, { recursive: true })
    writeFileSync(join(deployed, 'privacy.html'), page())
    const problems = await checkDeployment(
      await serve(deployed),
      probesFor(dir).filter((probe) => /^\/(privacy|%70rivacy|index\.html)$/.test(probe.path)),
    )
    for (const path of ['/privacy', '/%70rivacy']) {
      expect(problems).toContain(
        `${path}: the document has no <meta name="referrer" content="no-referrer">`,
      )
      expect(
        problems.some((problem) => problem.startsWith(`${path}: the document must carry`)),
      ).toBe(true)
    }
    expect(problems.filter((problem) => problem.startsWith('/index.html'))).toEqual([])
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
  const probes = probesFor(composed())
  const probe = probes.find((candidate) => candidate.path === '/sandbox/innertube')
  if (!probe) throw new Error('no sandbox probe')
  const base = new URL('https://fxmusic.pages.dev/')
  const headers = [...ruleOf(probe).headers] as [string, string][]
  const body = sandboxDocument('innertube.html')

  it('accepts exactly the expected headers and document', () => {
    expect(responseProblems(probe, { status: 200, headers, body }, base)).toEqual([])
  })

  it('counts repeated header lines, which a joined value would hide', () => {
    const doubled = [...headers, ['referrer-policy', 'no-referrer']] as [string, string][]
    expect(responseProblems(probe, { status: 200, headers: doubled, body }, base)).toEqual([
      '/sandbox/innertube: 2 referrer-policy headers, expected exactly one',
    ])
  })

  it("insists on the sandbox and allows 'unsafe-eval' only in the evaluator", () => {
    const loose = headers.map(([name, value]) =>
      name === 'content-security-policy'
        ? [name, "default-src 'none'; script-src 'unsafe-eval'"]
        : [name, value],
    ) as [string, string][]
    const fake = { ...probe, rule: { ...ruleOf(probe), headers: new Map(loose) } }
    expect(responseProblems(fake, { status: 200, headers: loose, body }, base)).toEqual([
      "/sandbox/innertube: Content-Security-Policy: 'unsafe-eval' outside the evaluator document",
      '/sandbox/innertube: Content-Security-Policy: a sandbox document without "sandbox allow-scripts"',
    ])
  })

  it('expects the opener policy, and a Permissions-Policy that leaves the player alone', () => {
    const response = headers
      .filter(([name]) => name !== 'cross-origin-opener-policy')
      .map(([name, value]) =>
        name === 'permissions-policy' ? [name, 'autoplay=()'] : [name, value],
      ) as [string, string][]
    const fake = { ...probe, rule: { ...ruleOf(probe), headers: new Map(response) } }
    expect(responseProblems(fake, { status: 200, headers: response, body }, base)).toEqual([
      '/sandbox/innertube: Permissions-Policy: it turns off autoplay, which the player may use',
    ])
    expect(responseProblems(probe, { status: 200, headers: response, body }, base)).toEqual([
      '/sandbox/innertube: 0 cross-origin-opener-policy headers, expected exactly one',
      `/sandbox/innertube: permissions-policy is\n      autoplay=()\n    expected\n      ${ruleOf(probe).headers.get('permissions-policy')}`,
      '/sandbox/innertube: Permissions-Policy: it turns off autoplay, which the player may use',
    ])
  })

  it('checks where a redirect points', () => {
    const redirect = probes.find((candidate) => candidate.path === '/privacy.html')
    const response = {
      status: 308,
      headers: [...ruleOf(redirect).headers, ['location', '/elsewhere']] as [string, string][],
    }
    expect(responseProblems(redirect as Probe, response, base)).toEqual([
      '/privacy.html: redirects to /elsewhere, expected /privacy',
    ])
  })

  it('expects a document where it probes one', () => {
    expect(responseProblems(probe, { status: 200, headers }, base)).toEqual([
      '/sandbox/innertube: not an HTML document',
    ])
  })
})
