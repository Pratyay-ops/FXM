/** Content-Security-Policy values: build, serialize, parse and hash. */
import { createHash } from 'node:crypto'
import { normalizeNewlines } from './html.ts'

/** One directive: its name and its source list (empty for directives such as `sandbox`). */
export type Directive = readonly [name: string, sources: readonly string[]]

/** An ordered list of directives; serialize() turns it into a header value. */
export type Policy = readonly Directive[]

export const SELF = "'self'"
export const NONE = "'none'"
export const UNSAFE_INLINE = "'unsafe-inline'"
export const UNSAFE_EVAL = "'unsafe-eval'"
export const WASM_UNSAFE_EVAL = "'wasm-unsafe-eval'"

/** `'sha256-…'` for an inline script or style, hashed as a browser hashes it. */
export function sha256Source(content: string): string {
  const digest = createHash('sha256').update(normalizeNewlines(content), 'utf8').digest('base64')
  return `'sha256-${digest}'`
}

/** The sources in order, without repeats. */
export function unique(sources: Iterable<string>): string[] {
  return [...new Set(sources)]
}

/** `name source source; name source` */
export function serializePolicy(policy: Policy): string {
  const names = new Set<string>()
  return policy
    .map(([name, sources]) => {
      if (names.has(name)) throw new Error(`directive ${name} appears twice`)
      names.add(name)
      for (const source of sources) {
        if (/[\s;,]/.test(source) || source === '') {
          throw new Error(`invalid source ${JSON.stringify(source)} in ${name}`)
        }
      }
      return [name, ...sources].join(' ')
    })
    .join('; ')
}

/**
 * Parses one policy into directive → sources. Throws on a comma, which separates two policies
 * (Cloudflare joins a header set by two `_headers` rules with a comma).
 */
export function parsePolicy(value: string): Map<string, string[]> {
  if (value.includes(',')) throw new Error('more than one policy (the value contains a comma)')
  const directives = new Map<string, string[]>()
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (!name) continue
    const key = name.toLowerCase()
    // Browsers ignore a repeated directive; treat it as an error so the checks notice.
    if (directives.has(key)) throw new Error(`directive ${key} appears twice`)
    directives.set(key, sources)
  }
  return directives
}

/** Directives a policy in a meta element can't carry (CSP3 §3.3): browsers ignore them there. */
export const HEADER_ONLY_DIRECTIVES: ReadonlySet<string> = new Set([
  'sandbox',
  'frame-ancestors',
  'report-uri',
])

/** A header's policy as a meta element can carry it: without the directives only a header can set. */
export function metaPolicyOf(header: string): string {
  return [...parsePolicy(header)]
    .filter(([name]) => !HEADER_ONLY_DIRECTIVES.has(name))
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ')
}
