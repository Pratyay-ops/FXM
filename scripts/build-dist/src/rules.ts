/**
 * Turns the composed folder into `_headers` rules: one Content-Security-Policy per path, plus
 * Referrer-Policy and X-Content-Type-Options, with no two rules matching the same path
 * (docs/PLAN.md, stage 2.8).
 *
 * | Files                   | Rule                                   | Policy                         |
 * |-------------------------|----------------------------------------|--------------------------------|
 * | app/**                  | /app/*                                 | appPolicy()                    |
 * | embed/**                | /embed/*                               | appPolicy({ embeddable })      |
 * | sandbox/<doc>.html      | /sandbox/<doc> and /sandbox/<doc>.html | SANDBOX_DOCUMENTS[<doc>.html]  |
 * | _astro/**, .well-known/** | /_astro/*, /.well-known/*            | STATIC_FILE_POLICY             |
 * | other .html files       | each page's path and its .html path    | sitePagePolicy() for that page |
 * | other files             | each file's path                       | STATIC_FILE_POLICY             |
 *
 * Pages serves `privacy.html` at `/privacy` and answers `/privacy.html` with a redirect to it,
 * so a document gets a rule for both. That matters most for the sandbox documents: the app
 * frames `/sandbox/innertube.html`, the browser follows the redirect, and the document at
 * `/sandbox/innertube` must still carry its `sandbox` policy.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Policy, serializePolicy, sha256Source } from './csp.ts'
import {
  type HeaderRule,
  MAX_LINE_LENGTH,
  MAX_RULES,
  matchingRules,
  parseHeaders,
  rulesOverlap,
  serializeHeaders,
} from './headers-file.ts'
import { type PageScan, scanPage } from './html.ts'
import {
  appPolicy,
  COMMON_HEADERS,
  isSandboxDocument,
  SANDBOX_DOCUMENTS,
  STATIC_FILE_POLICY,
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
  if (scan.referrerMetas.length > 0) {
    problems.push(
      `${file} has <meta name="referrer">, which would override Referrer-Policy: no-referrer`,
    )
  }
  if (!allowStyleAttributes && scan.styleAttributes.length > 0) {
    problems.push(
      `${file} has style attributes (${[...new Set(scan.styleAttributes)].join(', ')}), which the site's policy blocks: use a class`,
    )
  }
  return problems
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
  const problems: string[] = []
  const siteRules: HeaderRule[] = []
  const staticRules: HeaderRule[] = []
  const splatRules: HeaderRule[] = []
  const sandboxRules: HeaderRule[] = []

  const topFolder = (file: string) => (file.includes('/') ? file.slice(0, file.indexOf('/')) : '')
  const splatFolders = new Set(
    files.map(topFolder).filter((folder) => Object.hasOwn(SPLAT_FOLDERS, folder)),
  )

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

  for (const file of files) {
    const folder = topFolder(file)
    if (splatFolders.has(folder)) continue
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

  if (problems.length > 0) throw new RulesError(problems)
  const rules = [...siteRules, ...staticRules, ...splatRules, ...sandboxRules]
  const errors = validateRules(rules, files)
  if (errors.length > 0) throw new RulesError(errors)
  return rules
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
  const fileSet = new Set(files)
  const probes = files.flatMap((file) => servedPaths(file, fileSet))
  for (const folder of ['app', 'embed']) {
    if (files.some((file) => file.startsWith(`${folder}/`)))
      probes.push(`/${folder}/${SPA_PROBE_SEGMENT}`)
  }
  for (const path of probes) {
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
