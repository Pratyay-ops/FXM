/**
 * The header check of a deployment (docs/PLAN.md, stage 2.8): fetches every path the composed
 * folder serves and confirms that each response carries exactly one Content-Security-Policy,
 * the one `_headers` gives that path, plus `Referrer-Policy: no-referrer`,
 * `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin` and the
 * Permissions-Policy, each exactly once and as `_headers` gives them. It reads the raw header
 * lines, so a policy Cloudflare joined from two rules shows up as an error.
 *
 * Each document must also carry its policy in a meta element (and the site's pages and the
 * apps' documents `<meta name="referrer" content="no-referrer">`), which the check reads in
 * the body: at its own paths, and at paths with one character percent-encoded, which Pages
 * serves too but where no `_headers` rule applies (headers-file.ts). (That googlevideo
 * requests carry no Referer is checked in a browser, by e2e/deployed.e2e.ts.)
 *
 *   node check-headers.ts <base URL> [folder]     (default folder: dist/pages)
 */
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join, resolve } from 'node:path'
import { matchingRules, type ParsedRule, parseHeaders } from './headers-file.ts'
import { scanPage } from './html.ts'
import { isMain, PAGES_DIR } from './paths.ts'
import { permissionsPolicyProblems, policyProblems } from './policies.ts'
import {
  encodedVariants,
  inSplatFolder,
  isPolicyDocument,
  listFiles,
  metaPolicyProblems,
  SPA_PROBE_SEGMENT,
  servedPaths,
} from './rules.ts'

export interface Probe {
  readonly path: string
  readonly status: number
  /** For a redirect: where it must point. */
  readonly location?: string
  /**
   * The only rule that matches the path; its headers are what the response must carry.
   * Undefined for a percent-encoded path, which no rule can reach.
   */
  readonly rule?: ParsedRule
  /** For a document: the policy its meta element must carry, as its own path's header sets it. */
  readonly documentPolicy?: string
  /** The document must also carry `<meta name="referrer" content="no-referrer">`. */
  readonly referrerMeta?: boolean
}

/** Every request path worth checking for a composed folder, with what it must return. */
export function probesFor(dir: string): Probe[] {
  const { rules, invalid } = parseHeaders(readFileSync(join(dir, '_headers'), 'utf8'))
  if (invalid.length > 0) throw new Error(`_headers is invalid:\n  ${invalid.join('\n  ')}`)
  const files = listFiles(dir).filter((file) => file !== '_headers')
  const fileSet = new Set(files)
  const only = (path: string): ParsedRule => {
    const matches = matchingRules(rules, path)
    if (matches.length !== 1) throw new Error(`${path} matches ${matches.length} rules in _headers`)
    return matches[0] as ParsedRule
  }
  const documentOf = (
    file: string,
    canonical: string,
  ): Pick<Probe, 'documentPolicy' | 'referrerMeta'> => {
    if (!file.endsWith('.html')) return {}
    const policy = only(canonical).headers.get('content-security-policy')
    if (policy === undefined) throw new Error(`${canonical} has no policy in _headers`)
    return { documentPolicy: policy, referrerMeta: isPolicyDocument(file) }
  }
  const probes: Probe[] = []
  for (const file of files) {
    const [canonical, ...aliases] = servedPaths(file, fileSet) as [string, ...string[]]
    probes.push({
      path: canonical,
      status: 200,
      rule: only(canonical),
      ...documentOf(file, canonical),
    })
    for (const alias of aliases) {
      probes.push({ path: alias, status: 308, location: canonical, rule: only(alias) })
    }
  }
  for (const folder of ['app', 'embed']) {
    if (!fileSet.has(`${folder}/index.html`)) continue
    const path = `/${folder}/${SPA_PROBE_SEGMENT}`
    probes.push({ path, status: 404, rule: only(path), ...documentOf(`${folder}/404.html`, path) })
  }
  // The documents at paths with one character encoded: each page with rules of its own, and
  // each app's shell with its folder's name encoded.
  for (const file of files.filter((name) => name.endsWith('.html'))) {
    const inSplat = inSplatFolder(file)
    if (inSplat && !file.endsWith('/index.html')) continue
    const [canonical] = servedPaths(file, fileSet) as [string]
    for (const path of encodedVariants(canonical, inSplat ? 1 : Number.POSITIVE_INFINITY)) {
      probes.push({ path, status: 200, ...documentOf(file, canonical) })
    }
  }
  return probes
}

interface RawResponse {
  status: number
  /** Header lines as received, names lower-cased, repeats kept. */
  headers: [name: string, value: string][]
  /** The body of an HTML response, up to MAX_BODY bytes. */
  body?: string
}

/** The largest HTML body read; FXM's pages are far smaller. */
const MAX_BODY = 4 * 1024 * 1024

/** GET without following redirects, keeping repeated header lines apart. */
export function fetchRaw(url: URL, timeoutMs = 15_000): Promise<RawResponse> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolvePromise, reject) => {
    const req = request(
      url,
      { method: 'GET', headers: { 'user-agent': 'fxm-header-check/1' }, timeout: timeoutMs },
      (res) => {
        const headers: [string, string][] = []
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          headers.push([
            (res.rawHeaders[i] as string).toLowerCase(),
            res.rawHeaders[i + 1] as string,
          ])
        }
        const html = /^text\/html\b/i.test(res.headers['content-type'] ?? '')
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          if (!html || size > MAX_BODY) return
          size += chunk.length
          chunks.push(chunk)
        })
        res.on('end', () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            headers,
            ...(html ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)))
    req.on('error', reject)
    req.end()
  })
}

/** What is wrong with one response (an empty list when nothing is). */
export function responseProblems(probe: Probe, response: RawResponse, base: URL): string[] {
  const problems: string[] = []
  const say = (message: string) => problems.push(`${probe.path}: ${message}`)
  const values = (name: string) =>
    response.headers.filter(([header]) => header === name).map(([, value]) => value)
  if (response.status !== probe.status) say(`status ${response.status}, expected ${probe.status}`)
  if (probe.location !== undefined) {
    const [location] = values('location')
    const target = location === undefined ? undefined : new URL(location, base).pathname
    if (target !== probe.location)
      say(`redirects to ${location ?? 'nowhere'}, expected ${probe.location}`)
  }
  if (probe.rule) {
    for (const [name, expected] of probe.rule.headers) {
      const got = values(name)
      if (got.length !== 1) say(`${got.length} ${name} headers, expected exactly one`)
      else if (got[0] !== expected)
        say(`${name} is\n      ${got[0]}\n    expected\n      ${expected}`)
    }
    const policies = values('content-security-policy')
    if (policies.length === 1) {
      for (const problem of policyProblems(probe.rule.path, policies[0] as string)) {
        say(`Content-Security-Policy: ${problem}`)
      }
    }
    const permissions = values('permissions-policy')
    if (permissions.length === 1) {
      for (const problem of permissionsPolicyProblems(permissions[0] as string)) {
        say(`Permissions-Policy: ${problem}`)
      }
    }
  }
  if (probe.documentPolicy !== undefined) {
    if (response.body === undefined) say('not an HTML document')
    else {
      const scan = scanPage(response.body)
      for (const problem of metaPolicyProblems('the document', scan, probe.documentPolicy)) {
        say(problem)
      }
      if (probe.referrerMeta && !scan.referrerMetas.includes('no-referrer')) {
        say('the document has no <meta name="referrer" content="no-referrer">')
      }
    }
  }
  return problems
}

/** Checks every probe against the deployment at base. Network errors are retried twice. */
export async function checkDeployment(
  base: URL,
  probes: readonly Probe[],
  { concurrency = 6, retries = 2 } = {},
): Promise<string[]> {
  const problems: string[][] = []
  let next = 0
  const worker = async () => {
    while (next < probes.length) {
      const index = next++
      const probe = probes[index] as Probe
      const url = new URL(probe.path, base)
      for (let attempt = 0; ; attempt++) {
        try {
          problems[index] = responseProblems(probe, await fetchRaw(url), base)
          break
        } catch (error) {
          if (attempt >= retries) {
            problems[index] = [`${probe.path}: ${(error as Error).message}`]
            break
          }
          await new Promise((wait) => setTimeout(wait, 1000 * (attempt + 1)))
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, probes.length) }, worker))
  return problems.flat()
}

if (isMain(import.meta)) {
  const [baseArg, folderArg] = process.argv.slice(2)
  if (!baseArg) {
    console.error('usage: check-headers.ts <base URL> [folder]')
    process.exit(2)
  }
  const base = new URL(baseArg)
  const dir = resolve(folderArg ?? PAGES_DIR)
  const probes = probesFor(dir)
  const problems = await checkDeployment(base, probes)
  if (problems.length > 0) {
    console.error(`✘ ${problems.length} problem(s) on ${base.origin}:\n  ${problems.join('\n  ')}`)
    process.exitCode = 1
  } else {
    console.log(
      `✔ ${probes.length} paths on ${base.origin}: each has exactly the headers _headers gives it, and each document its policy`,
    )
  }
}
