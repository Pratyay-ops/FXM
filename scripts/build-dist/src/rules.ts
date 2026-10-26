/**
 * Turns the composed folder into `_headers` rules: one Content-Security-Policy per path, plus
 * the headers every response gets (COMMON_HEADERS: Referrer-Policy, X-Content-Type-Options,
 * Cross-Origin-Opener-Policy and Permissions-Policy), with no two rules matching the same path
 * (docs/PLAN.md, stage 2.8).
 *
 * | Files                     | Rule                                   | Policy                         |
 * |---------------------------|----------------------------------------|--------------------------------|
 * | app/**                    | /app/*                                 | appPolicy()                    |
 * | embed/**                  | /embed/*                               | appPolicy({ embeddable })      |
 * | sandbox/<doc>.html        | /sandbox/<doc> and /sandbox/<doc>.html | SANDBOX_DOCUMENTS[<doc>.html]  |
 * | _astro/**, .well-known/** | /_astro/*, /.well-known/*              | STATIC_FILE_POLICY             |
 * | other .html files         | each page's path and its .html path    | sitePagePolicy() for that page |
 * | other files               | each file's path                       | STATIC_FILE_POLICY             |
 *
 * Pages serves `privacy.html` at `/privacy` and answers `/privacy.html` with a redirect to it,
 * so a document gets a rule for both. That matters most for the sandbox documents: the app
 * frames `/sandbox/innertube.html`, the browser follows the redirect, and the document at
 * `/sandbox/innertube` must still carry its `sandbox` policy.
 *
 * Pages also serves a file at its path with a letter percent-encoded (`/priv%61cy`,
 * `/%61pp/`), where no `_headers` rule can apply (headers-file.ts). So every document carries
 * its policy in a meta element as well: make dist adds it to the site's pages and the apps'
 * documents (addDocumentPolicies), and the sandbox documents must bring their own and stay
 * inert unless their origin is opaque.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { metaPolicyOf, type Policy, parsePolicy, serializePolicy, sha256Source } from './csp.ts'
import {
  type HeaderRule,
  MAX_LINE_LENGTH,
  MAX_RULES,
  matchingRules,
  parseHeaders,
  rulesOverlap,
  serializeHeaders,
} from './headers-file.ts'
import { insertIntoHead, type PageScan, scanPage } from './html.ts'
import {
  appPolicy,
  COMMON_HEADERS,
  isSandboxDocument,
  permissionsPolicyProblems,
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

/** The documents make dist gives a policy in a meta element: every page but the sandbox's. */
export function isPolicyDocument(file: string): boolean {
  return file.endsWith('.html') && topFolder(file) !== 'sandbox'
}

/** `%` and the character's UTF-8 bytes in hex, as a browser would percent-encode it. */
function percentEncode(char: string): string {
  return [...Buffer.from(char, 'utf8')]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('')
}

/**
 * The path with one character percent-encoded, which Pages serves like the path itself and
 * no `_headers` rule matches: the first and the last character of each segment (`/privacy`:
 * `/%70rivacy`, `/privac%79`), and each slash after a segment (`/app%2F`). Browsers send such
 * paths as written (Chromium 1248, checked 2026-10-26). `segments` limits the variants to the
 * first segments.
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

/**
 * Why a document's policy in a meta element isn't its header policy minus the directives only a
 * header can set (an empty list when it is). The meta element must come before every script.
 */
export function metaPolicyProblems(file: string, scan: PageScan, headerPolicy: string): string[] {
  const expected = metaPolicyOf(headerPolicy)
  const want = `<meta http-equiv="Content-Security-Policy" content="${expected}">`
  const [meta, ...more] = scan.metaPolicies
  if (!meta || more.length > 0) {
    return [`${file} must carry its policy in exactly one ${want} before its script`]
  }
  if (!meta.beforeScripts) return [`${file} must put its policy's meta element before its script`]
  let actual: Map<string, string[]>
  try {
    actual = parsePolicy(meta.content)
  } catch (error) {
    return [`${file}: the policy in its meta element is invalid (${(error as Error).message})`]
  }
  if (!samePolicy(actual, parsePolicy(expected))) {
    return [
      `${file}: the policy in its meta element is\n      ${meta.content}\n    but must be\n      ${expected}`,
    ]
  }
  return []
}

/**
 * The opaque-origin test every sandbox document's script must make before anything else:
 * `self.origin` is `'null'` only where the `sandbox` policy applied, while `location.origin`
 * still names FXM's origin. Only the presence of the test can be checked here.
 */
const OPAQUE_ORIGIN_TEST =
  /\bself\.origin\s*[!=]==?\s*(['"])null\1|(['"])null\2\s*[!=]==?\s*self\.origin\b/

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

  for (const file of files.filter((name) => name.includes('%'))) {
    problems.push(
      `${file}: a file name with % can't have a rule of its own, because Pages decodes request paths: rename it`,
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
      if (scan.metaPolicies.length > 0) {
        problems.push(`${document} has a policy in a meta element: make dist writes it`)
      }
      hashes.push(...scan.inlineScripts.map(sha256Source))
    }
    splatRules.push(rule(`/${folder}/*`, appPolicy(hashes, { embeddable: family === 'embed' })))
  }

  for (const file of files.filter((name) => !inSplatFolder(name))) {
    if (topFolder(file) === 'sandbox') {
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
      else if (!scan.inlineScripts.every((script) => OPAQUE_ORIGIN_TEST.test(script))) {
        problems.push(
          `${file} must do nothing unless self.origin === 'null' (src/later-stages.ts): Pages also serves it at paths its sandbox policy can't reach`,
        )
      }
      const policy = SANDBOX_DOCUMENTS[name](scan.inlineScripts.map(sha256Source))
      problems.push(...metaPolicyProblems(file, scan, serializePolicy(policy)))
      for (const path of servedPaths(file, fileSet)) sandboxRules.push(rule(path, policy))
      continue
    }
    if (file.endsWith('.html')) {
      const scan = scanPage(readHtml(file))
      problems.push(...pageProblems(file, scan))
      if (scan.metaPolicies.length > 0) {
        problems.push(`${file} has a policy in a meta element: make dist writes it`)
      }
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

  if (problems.length > 0) throw new RulesError(problems)
  const rules = [...siteRules, ...staticRules, ...splatRules, ...sandboxRules]
  const errors = validateRules(rules, files)
  if (errors.length > 0) throw new RulesError(errors)
  return rules
}

/**
 * Adds to every site page and app document its policy in a meta element (the header's, minus
 * the directives only a header can set) and `<meta name="referrer" content="no-referrer">`,
 * at the start of its head. They apply wherever Pages serves the document, also at the
 * percent-encoded paths no `_headers` rule reaches. Throws when a document can't take them.
 */
export function addDocumentPolicies(pagesDir: string, rules: readonly HeaderRule[]): void {
  const files = listFiles(pagesDir)
  const fileSet = new Set(files)
  const problems: string[] = []
  for (const file of files.filter(isPolicyDocument)) {
    const html = readFileSync(join(pagesDir, file), 'utf8')
    const scan = scanPage(html)
    const [canonical] = servedPaths(file, fileSet) as [string]
    const [match, ...more] = matchingRules(rules, canonical)
    const policy = match?.headers.find(([name]) => name === 'Content-Security-Policy')?.[1]
    if (!policy || more.length > 0) {
      problems.push(`${file}: ${canonical} has no single rule with a policy`)
      continue
    }
    const elements = [
      `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(metaPolicyOf(policy))}">`,
      ...(scan.referrerMetas.length > 0 ? [] : ['<meta name="referrer" content="no-referrer">']),
    ]
    let updated: string
    try {
      updated = insertIntoHead(html, elements.join(''))
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`)
      continue
    }
    const check = metaPolicyProblems(file, scanPage(updated), policy)
    if (check.length > 0) problems.push(...check)
    else writeFileSync(join(pagesDir, file), updated)
  }
  if (problems.length > 0) throw new RulesError(problems)
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}

/** Request paths a composed folder must answer with exactly one rule's headers. */
export function probePaths(files: readonly string[]): string[] {
  const fileSet = new Set(files)
  const probes = files.flatMap((file) => servedPaths(file, fileSet))
  for (const folder of ['app', 'embed']) {
    if (files.some((file) => file.startsWith(`${folder}/`)))
      probes.push(`/${folder}/${SPA_PROBE_SEGMENT}`)
  }
  return probes
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
    if (values('cross-origin-opener-policy').join() !== 'same-origin') {
      errors.push(`${path}: Cross-Origin-Opener-Policy must be same-origin, once`)
    }
    const permissions = values('permissions-policy')
    if (permissions.length !== 1) {
      errors.push(`${path}: ${permissions.length} Permissions-Policy headers`)
    }
    for (const problem of permissions.flatMap(permissionsPolicyProblems)) {
      errors.push(`${path}: Permissions-Policy: ${problem}`)
    }
  }
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = (rules[i] as HeaderRule).path
      const b = (rules[j] as HeaderRule).path
      if (rulesOverlap(a, b)) errors.push(`rules ${a} and ${b} match the same paths`)
    }
  }
  // Read back as Cloudflare will, to be sure the file means exactly these rules.
  const text = serializeHeaders(rules)
  const parsed = parseHeaders(text)
  errors.push(...parsed.invalid)
  if (parsed.rules.length !== rules.length) {
    errors.push(`the _headers file reads back as ${parsed.rules.length} rules, not ${rules.length}`)
  }
  parsed.rules.forEach((read, index) => {
    const written = rules[index]?.path
    if (written !== undefined && read.path !== written) {
      errors.push(`the rule for ${written} reads back as ${read.path}`)
    }
  })
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
