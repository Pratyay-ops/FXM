/**
 * Turns the composed folder into `_headers` rules: one Content-Security-Policy per path, plus
 * Referrer-Policy and X-Content-Type-Options (docs/PLAN.md, stage 2.8).
 *
 * | Files                     | Rule                                   | Policy                         |
 * |---------------------------|----------------------------------------|--------------------------------|
 * | app/**                    | /app/*                                 | appPolicy()                    |
 * | embed/**                  | /embed/*                               | appPolicy({ embeddable })      |
 * | sandbox/<doc>.html        | /sandbox/<doc> and /sandbox/<doc>.html | SANDBOX_DOCUMENTS[<doc>.html]  |
 * | _astro/**, .well-known/** | /_astro/*, /.well-known/*              | STATIC_FILE_POLICY             |
 * | other .html files         | each page's path and its .html path    | sitePagePolicy() for that page |
 * | other files               | each file's path                       | STATIC_FILE_POLICY             |
 * | encoded paths             | <folder>/%* and <folder>/:name%*       | ENCODED_PATH_POLICY            |
 *
 * Pages serves `privacy.html` at `/privacy` and answers `/privacy.html` with a redirect to it,
 * so a document gets a rule for both. That matters most for the sandbox documents: the app
 * frames `/sandbox/innertube.html`, the browser follows the redirect, and the document at
 * `/sandbox/innertube` must still carry its `sandbox` policy.
 *
 * Pages also decodes a request path to find its file but matches `_headers` against the path
 * as sent, so `/priv%61cy` serves privacy.html without the rules of `/privacy`. Every folder
 * that holds files with rules of their own (the root, sandbox/) therefore gets two more rules,
 * which only a path with a `%` in the segment after the folder can match: `<folder>/%*` and
 * `<folder>/:name%*`. Their policy runs nothing. The splat folders need none: `/app/*` matches
 * `/app/%61ssets/x.js` as it is.
 *
 * No two rules match the same path, with one exception: a segment that starts with `%` and has
 * another `%` later, such as `/%61%70p/`, matches both of its folder's encoded-path rules.
 * Those two rules set the same headers, so the values Cloudflare joins repeat one policy.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Policy, parsePolicy, serializePolicy, sha256Source } from './csp.ts'
import {
  type HeaderRule,
  MAX_LINE_LENGTH,
  MAX_RULES,
  matchingRules,
  parseHeaders,
  ruleShape,
  rulesOverlap,
  serializeHeaders,
} from './headers-file.ts'
import { type PageScan, scanPage } from './html.ts'
import {
  appPolicy,
  COMMON_HEADERS,
  ENCODED_PATH_POLICY,
  isSandboxDocument,
  policyProblems,
  SANDBOX_DOCUMENTS,
  STATIC_FILE_POLICY,
  serviceProblems,
  sitePagePolicy,
} from './policies.ts'

/** Folders served by one splat rule, and the policy family of each. */
const SPLAT_FOLDERS = {
  app: 'app',
  embed: 'embed',
  _astro: 'static',
  '.well-known': 'static',
} as const

/** A path inside a single-page app that no file answers: Pages serves the app's 404.html. */
export const SPA_PROBE_SEGMENT = '__fxm-route-check__/deep/link'

/** The placeholder in the `<folder>/:name%*` rules. */
const ENCODED_PLACEHOLDER = ':name'

/** Every file in a folder, as sorted POSIX paths relative to it (dot-files included). */
export function listFiles(dir: string): string[] {
  const files: string[] = []
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(path)
      else
        throw new Error(`${path} is neither a file nor a folder (symbolic links are not deployed)`)
    }
  }
  walk('')
  return files.sort()
}

/**
 * The request paths Pages serves a file at, the way its asset server resolves them: the
 * canonical path that returns the file, then the file's own path when that only redirects.
 */
export function servedPaths(file: string, files: ReadonlySet<string>): string[] {
  const path = `/${file}`
  if (!file.endsWith('.html')) return [path]
  const extensionless = path.slice(0, -'.html'.length)
  if (extensionless === '/index') return ['/', path]
  if (extensionless.endsWith('/index')) return [extensionless.slice(0, -'index'.length), path]
  // When a file with the extension-less name exists too, Pages serves the .html file as is.
  if (files.has(extensionless.slice(1))) return [path]
  return [extensionless, path]
}

/** The top-level folder of a file ('' at the root). */
function topFolder(file: string): string {
  return file.includes('/') ? file.slice(0, file.indexOf('/')) : ''
}

/** True for files under a folder that one splat rule serves (app/, embed/, _astro/, …). */
export function inSplatFolder(file: string): boolean {
  return Object.hasOwn(SPLAT_FOLDERS, topFolder(file))
}

/** `%` and the character's UTF-8 bytes in hex, as a browser would percent-encode it. */
function percentEncode(char: string): string {
  return [...Buffer.from(char, 'utf8')]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('')
}

/**
 * The path with one character percent-encoded, which Pages serves like the path itself: the
 * first and the last character of each segment (`/privacy`: `/%70rivacy`, `/privac%79`), and
 * each slash after a segment (`/app%2F`). Browsers send such paths as written (Chromium 1248,
 * checked 2026-10-26). `segments` limits the variants to the first segments.
 */
export function encodedVariants(path: string, segments = Number.POSITIVE_INFINITY): string[] {
  const parts = path.split('/')
  const variants = new Set<string>()
  parts.forEach((segment, index) => {
    if (!segment || index > segments) return
    const chars = [...segment]
    for (const at of new Set([0, chars.length - 1])) {
      const encoded = [
        ...chars.slice(0, at),
        percentEncode(chars[at] as string),
        ...chars.slice(at + 1),
      ]
      variants.add(
        [...parts.slice(0, index), encoded.join(''), ...parts.slice(index + 1)].join('/'),
      )
    }
    if (index < parts.length - 1) {
      variants.add(`${parts.slice(0, index + 1).join('/')}%2F${parts.slice(index + 1).join('/')}`)
    }
  })
  return [...variants]
}

/** The folder of an encoded-path rule (`/` or `/sandbox/`), or undefined for any other rule. */
export function encodedRuleFolder(rulePath: string): string | undefined {
  const shape = ruleShape(rulePath)
  if (shape.kind === 'encoded') return shape.folder
  if (shape.kind === 'prefix' && shape.literal.endsWith('%')) return shape.literal.slice(0, -1)
  return undefined
}

/** Problems a policy can't fix: the page itself has to change. */
function pageProblems(
  file: string,
  scan: PageScan,
  { allowStyleAttributes = false } = {},
): string[] {
  const problems: string[] = []
  // A URL with a scheme (https:, data:) or a host (//cdn…) isn't this site's own file.
  const elsewhere = (url: string) => /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url.trim())
  for (const url of [...scan.scriptUrls, ...scan.modulePreloadUrls].filter(elsewhere)) {
    problems.push(`${file} loads a script from ${url}: serve it from this site`)
  }
  for (const url of scan.stylesheetUrls.filter(elsewhere)) {
    problems.push(`${file} loads a stylesheet from ${url}: serve it from this site`)
  }
  if (scan.eventHandlers.length > 0) {
    problems.push(
      `${file} has inline event handlers (${scan.eventHandlers.join(', ')}): use addEventListener in a script`,
    )
  }
  if (scan.javascriptUrls.length > 0) {
    problems.push(`${file} has javascript: URLs (${scan.javascriptUrls.join(', ')})`)
  }
  // The same value as the header is harmless; any other would override it.
  const overriding = scan.referrerMetas.filter(
    (value) => value.trim().toLowerCase() !== 'no-referrer',
  )
  if (overriding.length > 0) {
    problems.push(
      `${file} has <meta name="referrer" content="${overriding[0]}">, which would override Referrer-Policy: no-referrer`,
    )
  }
  if (!allowStyleAttributes && scan.styleAttributes.length > 0) {
    problems.push(
      `${file} has style attributes (${[...new Set(scan.styleAttributes)].join(', ')}), which the site's policy blocks: use a class`,
    )
  }
  return problems
}

/** The same directives with the same sources, in any order. */
function samePolicy(a: ReadonlyMap<string, string[]>, b: ReadonlyMap<string, string[]>): boolean {
  if (a.size !== b.size) return false
  const sorted = (sources: readonly string[]) => [...sources].sort().join(' ')
  return [...a].every(
    ([name, sources]) => b.has(name) && sorted(b.get(name) ?? []) === sorted(sources),
  )
}

/** Directives a policy in a meta element can't carry (CSP3 §3.3): browsers ignore them there. */
const HEADER_ONLY_DIRECTIVES = new Set(['sandbox', 'frame-ancestors', 'report-uri'])

/**
 * A sandbox document must repeat its policy, minus `sandbox`, in a meta element before its
 * script. Then it keeps its hosts and its script hash wherever it is served without its
 * headers: from a copy of the release zip on another host, or after a mistake in `_headers`.
 */
function sandboxMetaProblems(file: string, scan: PageScan, policy: Policy): string[] {
  const expected = policy.filter(([name]) => !HEADER_ONLY_DIRECTIVES.has(name))
  const want = `<meta http-equiv="Content-Security-Policy" content="${serializePolicy(expected)}">`
  const [meta, ...more] = scan.metaPolicies
  if (!meta || more.length > 0) {
    return [
      `${file} must carry its policy, without sandbox, in exactly one ${want} before its script`,
    ]
  }
  if (!meta.beforeScripts) return [`${file} must put its policy's meta element before its script`]
  let actual: Map<string, string[]>
  try {
    actual = parsePolicy(meta.content)
  } catch (error) {
    return [`${file}: the policy in its meta element is invalid (${(error as Error).message})`]
  }
  if (!samePolicy(actual, parsePolicy(serializePolicy(expected)))) {
    return [
      `${file}: the policy in its meta element is\n      ${meta.content}\n    but must be\n      ${serializePolicy(expected)}`,
    ]
  }
  return []
}

function rule(path: string, policy: Policy): HeaderRule {
  return {
    path,
    headers: [['Content-Security-Policy', serializePolicy(policy)], ...COMMON_HEADERS],
  }
}

/** The `_headers` rules for a composed folder. Throws when a file can't get a correct policy. */
export function generateRules(pagesDir: string): HeaderRule[] {
  const files = listFiles(pagesDir).filter((file) => file !== '_headers')
  const fileSet = new Set(files)
  const readHtml = (file: string) => readFileSync(join(pagesDir, file), 'utf8')
  const problems: string[] = [...serviceProblems()]
  const siteRules: HeaderRule[] = []
  const staticRules: HeaderRule[] = []
  const splatRules: HeaderRule[] = []
  const sandboxRules: HeaderRule[] = []
  const encodedRules: HeaderRule[] = []

  for (const file of files.filter((name) => name.includes('%'))) {
    problems.push(
      `${file}: a file name with % can't have rules of its own, because Pages decodes request paths: rename it`,
    )
  }

  const splatFolders = new Set(files.filter(inSplatFolder).map(topFolder))
  for (const folder of [...splatFolders].sort()) {
    const family = SPLAT_FOLDERS[folder as keyof typeof SPLAT_FOLDERS]
    if (family === 'static') {
      splatRules.push(rule(`/${folder}/*`, STATIC_FILE_POLICY))
      continue
    }
    if (!fileSet.has(`${folder}/index.html`)) {
      problems.push(`${folder}/ has no index.html`)
      continue
    }
    // One policy covers every document in the folder (index.html, its 404.html copy, …).
    const hashes: string[] = []
    for (const document of files.filter(
      (file) => file.startsWith(`${folder}/`) && file.endsWith('.html'),
    )) {
      const scan = scanPage(readHtml(document))
      // The app's policy allows inline styles (React sets them), so only the rest is checked.
      problems.push(...pageProblems(document, scan, { allowStyleAttributes: true }))
      hashes.push(...scan.inlineScripts.map(sha256Source))
    }
    splatRules.push(rule(`/${folder}/*`, appPolicy(hashes, { embeddable: family === 'embed' })))
  }

  // Folders holding files with rules of their own: each, and each folder above it.
  const encodedFolders = new Set<string>()
  for (const file of files.filter((name) => !inSplatFolder(name))) {
    const parts = file.split('/').slice(0, -1)
    for (let depth = 0; depth <= parts.length; depth++) {
      encodedFolders.add(parts.slice(0, depth).join('/'))
    }
    const folder = topFolder(file)
    if (folder === 'sandbox') {
      const name = file.slice('sandbox/'.length)
      if (!isSandboxDocument(name)) {
        problems.push(
          `${file} has no policy: sandbox/ may only hold ${Object.keys(SANDBOX_DOCUMENTS).join(', ')} (src/policies.ts)`,
        )
        continue
      }
      const scan = scanPage(readHtml(file))
      problems.push(...pageProblems(file, scan))
      if (scan.scriptUrls.length > 0 || scan.modulePreloadUrls.length > 0) {
        problems.push(`${file} must inline its script: its policy allows scripts by hash only`)
      }
      if (scan.inlineScripts.length === 0) problems.push(`${file} has no inline script`)
      const policy = SANDBOX_DOCUMENTS[name](scan.inlineScripts.map(sha256Source))
      problems.push(...sandboxMetaProblems(file, scan, policy))
      for (const path of servedPaths(file, fileSet)) sandboxRules.push(rule(path, policy))
      continue
    }
    if (file.endsWith('.html')) {
      const scan = scanPage(readHtml(file))
      problems.push(...pageProblems(file, scan))
      const policy = sitePagePolicy({
        scriptHashes: scan.inlineScripts.map(sha256Source),
        styleHashes: scan.inlineStyles.map(sha256Source),
        externalScripts: scan.scriptUrls.length + scan.modulePreloadUrls.length > 0,
        externalStyles: scan.stylesheetUrls.length > 0,
      })
      for (const path of servedPaths(file, fileSet)) siteRules.push(rule(path, policy))
    } else {
      staticRules.push(rule(`/${file}`, STATIC_FILE_POLICY))
    }
  }
  for (const folder of [...encodedFolders].sort()) {
    const base = folder ? `/${folder}/` : '/'
    encodedRules.push(rule(`${base}%*`, ENCODED_PATH_POLICY))
    encodedRules.push(rule(`${base}${ENCODED_PLACEHOLDER}%*`, ENCODED_PATH_POLICY))
  }

  if (problems.length > 0) throw new RulesError(problems)
  const rules = [...siteRules, ...staticRules, ...splatRules, ...sandboxRules, ...encodedRules]
  const errors = validateRules(rules, files)
  if (errors.length > 0) throw new RulesError(errors)
  return rules
}

/** Request paths a composed folder must answer with exactly one rule's headers. */
export function probePaths(files: readonly string[]): string[] {
  const fileSet = new Set(files)
  const probes = files.flatMap((file) => servedPaths(file, fileSet))
  for (const folder of ['app', 'embed']) {
    if (files.some((file) => file.startsWith(`${folder}/`)))
      probes.push(`/${folder}/${SPA_PROBE_SEGMENT}`)
  }
  // Each path with one character percent-encoded, which Pages serves like the path itself.
  probes.push(...files.flatMap((file) => encodedVariants(servedPaths(file, fileSet)[0] as string)))
  return [...new Set(probes)]
}

/** True when two rules are their folder's encoded-path rules, with the same headers. */
function encodedPair(a: HeaderRule, b: HeaderRule): boolean {
  const folder = encodedRuleFolder(a.path)
  return (
    folder !== undefined &&
    folder === encodedRuleFolder(b.path) &&
    JSON.stringify(a.headers) === JSON.stringify(b.headers)
  )
}

/** Every reason the rules are not safe to deploy (an empty list when they are). */
export function validateRules(rules: readonly HeaderRule[], files: readonly string[]): string[] {
  const errors: string[] = []
  if (rules.length > MAX_RULES) {
    errors.push(`${rules.length} rules, but Cloudflare reads only ${MAX_RULES}`)
  }
  for (const { path, headers } of rules) {
    for (const [name, value] of headers) {
      const length = `  ${name}: ${value}`.length
      if (length > MAX_LINE_LENGTH) {
        errors.push(
          `${path}: the ${name} line has ${length} characters, over Cloudflare's ${MAX_LINE_LENGTH}`,
        )
      }
    }
    const values = (name: string) =>
      headers.filter(([header]) => header.toLowerCase() === name).map(([, value]) => value)
    const policies = values('content-security-policy')
    if (policies.length !== 1)
      errors.push(`${path}: ${policies.length} Content-Security-Policy headers`)
    for (const problem of policies.flatMap((policy) => policyProblems(path, policy))) {
      errors.push(`${path}: ${problem}`)
    }
    if (values('referrer-policy').join() !== 'no-referrer') {
      errors.push(`${path}: Referrer-Policy must be no-referrer, once`)
    }
    if (values('x-content-type-options').join() !== 'nosniff') {
      errors.push(`${path}: X-Content-Type-Options must be nosniff, once`)
    }
  }
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i] as HeaderRule
      const b = rules[j] as HeaderRule
      if (rulesOverlap(a.path, b.path) && !encodedPair(a, b))
        errors.push(`rules ${a.path} and ${b.path} match the same paths`)
    }
  }
  // Read back as Cloudflare will, to be sure the file means exactly these rules.
  const text = serializeHeaders(rules)
  const parsed = parseHeaders(text)
  errors.push(...parsed.invalid)
  if (parsed.rules.length !== rules.length) {
    errors.push(`the _headers file reads back as ${parsed.rules.length} rules, not ${rules.length}`)
  }
  for (const path of probePaths(files)) {
    const matches = matchingRules(rules, path)
    if (matches.length !== 1) {
      errors.push(
        `${path} matches ${matches.length} rules${matches.length ? `: ${matches.map((m) => m.path).join(', ')}` : ''}`,
      )
    }
  }
  return errors
}

/** Rules that can't be generated, with every reason. */
export class RulesError extends Error {
  readonly problems: readonly string[]
  constructor(problems: readonly string[]) {
    super(`Can't write _headers:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.name = 'RulesError'
    this.problems = problems
  }
}
