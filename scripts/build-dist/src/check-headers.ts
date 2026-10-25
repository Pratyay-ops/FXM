/**
 * The header check of a deployment (docs/PLAN.md, stage 2.8): fetches every path the composed
 * folder serves and confirms that each response carries exactly one Content-Security-Policy,
 * the one `_headers` gives that path, plus `Referrer-Policy: no-referrer` and
 * `X-Content-Type-Options: nosniff`, each exactly once. It reads the raw header lines, so a
 * policy Cloudflare joined from two rules shows up as an error. It also fetches each document
 * at a path with one character percent-encoded, which Pages serves like the path itself, and
 * expects the encoded-path rules' headers there. (That googlevideo requests carry no Referer is
 * checked in a browser, by e2e/deployed.e2e.ts.)
 *
 *   node check-headers.ts <base URL> [folder]     (default folder: dist/pages)
 */
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join, resolve } from 'node:path'
import { matchingRules, type ParsedRule, parseHeaders } from './headers-file.ts'
import { isMain, PAGES_DIR } from './paths.ts'
import { policyProblems } from './policies.ts'
import {
  encodedVariants,
  inSplatFolder,
  listFiles,
  SPA_PROBE_SEGMENT,
  servedPaths,
} from './rules.ts'

export interface Probe {
  readonly path: string
  readonly status: number
  /** For a redirect: where it must point. */
  readonly location?: string
  /** The only rule that matches the path; its headers are what the response must carry. */
  readonly rule: ParsedRule
}

/** Every request path worth checking for a composed folder, with what it must return. */
export function probesFor(dir: string): Probe[] {
  const { rules, invalid } = parseHeaders(readFileSync(join(dir, '_headers'), 'utf8'))
  if (invalid.length > 0) throw new Error(`_headers is invalid:\n  ${invalid.join('\n  ')}`)
  const files = listFiles(dir).filter((file) => file !== '_headers')
  const fileSet = new Set(files)
  const wanted: Omit<Probe, 'rule'>[] = []
  for (const file of files) {
    const [canonical, ...aliases] = servedPaths(file, fileSet) as [string, ...string[]]
    wanted.push({ path: canonical, status: 200 })
    for (const alias of aliases) wanted.push({ path: alias, status: 308, location: canonical })
  }
  for (const folder of ['app', 'embed']) {
    if (fileSet.has(`${folder}/index.html`))
      wanted.push({ path: `/${folder}/${SPA_PROBE_SEGMENT}`, status: 404 })
  }
  // Pages decodes a path to find its file: every document with rules of its own, and each
  // splat folder (its name only, since its rule covers the rest), with one character encoded.
  const encoded = new Set<string>()
  for (const file of files.filter((name) => !inSplatFolder(name) && name.endsWith('.html'))) {
    for (const path of encodedVariants(servedPaths(file, fileSet)[0] as string)) encoded.add(path)
  }
  const splatFolders = new Set(files.filter(inSplatFolder).map((file) => file.split('/')[0]))
  for (const folder of [...splatFolders].sort()) {
    const file = fileSet.has(`${folder}/index.html`)
      ? `${folder}/index.html`
      : (files.find((name) => name.startsWith(`${folder}/`)) as string)
    for (const path of encodedVariants(servedPaths(file, fileSet)[0] as string, 1)) {
      encoded.add(path)
    }
  }
  for (const path of encoded) wanted.push({ path, status: 200 })
  return wanted.map((probe) => {
    const matches = matchingRules(rules, probe.path)
    if (matches.length !== 1)
      throw new Error(`${probe.path} matches ${matches.length} rules in _headers`)
    return { ...probe, rule: matches[0] as ParsedRule }
  })
}

interface RawResponse {
  status: number
  /** Header lines as received, names lower-cased, repeats kept. */
  headers: [name: string, value: string][]
}

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
        res.resume()
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers }))
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
      `✔ ${probes.length} paths on ${base.origin}: each has exactly the headers _headers gives it`,
    )
  }
}
