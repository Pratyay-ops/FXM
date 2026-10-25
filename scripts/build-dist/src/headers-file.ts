/**
 * Cloudflare Pages `_headers` files: writing them, and reading and matching them the way Pages
 * does (wrangler 4.149's parseHeaders and its asset server's rules engine, read 2026-10-26).
 *
 * - A rule is a path line followed by indented `name: value` lines. Lines are trimmed, `#`
 *   starts a comment, and a line over 2,000 characters is ignored. At most 100 rules count.
 * - A path matches the request's pathname; `*` matches anything (one per rule) and `:name`
 *   matches one path segment.
 * - A request gets the headers of every rule that matches, in file order. The first rule to
 *   set a header replaces Cloudflare's default; a later one appends, which joins the values
 *   with a comma. That is why `make dist` never lets two rules match one path.
 *
 * Absolute (`https://host/path`) rules and `! Name` removals are valid on Cloudflare, but FXM
 * doesn't use them, so the parser here reports them as errors instead of modelling them.
 */

/** Cloudflare's limits (developers.cloudflare.com/pages/configuration/headers, 2026-08-25). */
export const MAX_RULES = 100
export const MAX_LINE_LENGTH = 2000

export interface HeaderRule {
  /** A path pattern: an exact path, or a prefix followed by one `*`. */
  readonly path: string
  /** Header names as written, with their values, in order. */
  readonly headers: readonly (readonly [name: string, value: string])[]
}

/** A parsed rule: header names lower-cased, repeated names joined with ", " as Pages does. */
export interface ParsedRule {
  readonly path: string
  readonly headers: ReadonlyMap<string, string>
  readonly line: number
}

const INDENT = '  '

/** Writes rules as a `_headers` file. */
export function serializeHeaders(
  rules: readonly HeaderRule[],
  comment: readonly string[] = [],
): string {
  const lines = comment.map((line) => (line ? `# ${line}` : '#'))
  for (const rule of rules) {
    if (lines.length > 0) lines.push('')
    lines.push(rule.path)
    for (const [name, value] of rule.headers) lines.push(`${INDENT}${name}: ${value}`)
  }
  return `${lines.join('\n')}\n`
}

/** Reads a `_headers` file. `invalid` lists what Cloudflare would skip or FXM doesn't use. */
export function parseHeaders(text: string): { rules: ParsedRule[]; invalid: string[] } {
  const rules: ParsedRule[] = []
  const invalid: string[] = []
  let current: { path: string; headers: Map<string, string>; line: number } | undefined
  let skipping = false
  let tooMany = false

  const close = () => {
    if (!current) return
    if (current.headers.size === 0)
      invalid.push(`line ${current.line}: ${current.path} has no headers`)
    else rules.push(current)
    current = undefined
  }

  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const number = index + 1
    const raw = lines[index] as string
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    // Cloudflare measures the trimmed line; the docs count the indent too, so FXM does.
    if (raw.length > MAX_LINE_LENGTH) {
      invalid.push(
        `line ${number}: longer than ${MAX_LINE_LENGTH} characters, Cloudflare ignores it`,
      )
      continue
    }
    if (/^[^\s]+:\/\//.test(line)) {
      close()
      invalid.push(`line ${number}: absolute URL rules are not used by FXM: ${line}`)
      skipping = true
      continue
    }
    if (line.startsWith('/')) {
      close()
      if (rules.length >= MAX_RULES) {
        invalid.push(`line ${number}: more than ${MAX_RULES} rules, Cloudflare ignores the rest`)
        tooMany = true
        break
      }
      if ((line.match(/\*/g) ?? []).length > 1) {
        invalid.push(`line ${number}: only one * is allowed per rule: ${line}`)
        skipping = true
        continue
      }
      if (/\s/.test(line)) {
        invalid.push(`line ${number}: a path can't contain spaces: ${line}`)
        skipping = true
        continue
      }
      current = { path: line, headers: new Map(), line: number }
      skipping = false
      continue
    }
    if (skipping) continue
    if (!current) {
      invalid.push(`line ${number}: a header before any path: ${line}`)
      continue
    }
    if (line.startsWith('! ')) {
      invalid.push(`line ${number}: header removal (${line}) is not used by FXM`)
      continue
    }
    const colon = line.indexOf(':')
    const name = colon === -1 ? '' : line.slice(0, colon).trim().toLowerCase()
    const value = colon === -1 ? '' : line.slice(colon + 1).trim()
    if (!name || !value || /\s/.test(name)) {
      invalid.push(`line ${number}: expected "Name: value": ${line}`)
      continue
    }
    const previous = current.headers.get(name)
    current.headers.set(name, previous === undefined ? value : `${previous}, ${value}`)
  }
  if (!tooMany) close()
  return { rules, invalid }
}

/** The regular expression Pages compiles a relative rule path into. */
export function ruleRegExp(path: string): RegExp {
  const escapeRegExp = (part: string) => part.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  let source = path.split('*').map(escapeRegExp).join('(?<splat>.*)')
  source = source.replace(/:([A-Za-z]\w*)/g, '(?<$1>[^/]+)')
  return new RegExp(`^${source}$`)
}

/** The rules whose path matches a request's pathname, in file order. */
export function matchingRules<Rule extends { readonly path: string }>(
  rules: readonly Rule[],
  pathname: string,
): Rule[] {
  return rules.filter((rule) => ruleRegExp(rule.path).test(pathname))
}

/**
 * The shapes of rule path FXM writes, as the sets of paths they match:
 *
 * - `exact`: one path, such as `/privacy`;
 * - `prefix`: every path that starts with `literal`. `/app/*` (literal `/app/`) is one, and so
 *   is the encoded-path guard `<folder>/%*` (literal `<folder>/%`);
 * - `encoded`: the other encoded-path guard, `<folder>/:name%*`: the folder, then a segment
 *   with a `%` after its first character, then anything.
 */
type RuleShape =
  | { readonly kind: 'exact'; readonly path: string }
  | { readonly kind: 'prefix'; readonly path: string; readonly literal: string }
  | { readonly kind: 'encoded'; readonly path: string; readonly folder: string }

/** The shape of a rule path, or an error for one FXM never writes. */
export function ruleShape(path: string): RuleShape {
  const encoded = /^((?:\/[^/:*%]+)*\/):[A-Za-z]\w*%\*$/.exec(path)
  if (encoded) return { kind: 'encoded', path, folder: encoded[1] as string }
  if (path.includes(':')) throw new Error(`placeholders are not used by FXM: ${path}`)
  const star = path.indexOf('*')
  if (star === -1) {
    if (path.includes('%')) throw new Error(`a rule path can't contain %: ${path}`)
    return { kind: 'exact', path }
  }
  const literal = path.slice(0, -1)
  if (star !== path.length - 1 || !/\/%?$/.test(literal) || literal.slice(0, -1).includes('%')) {
    throw new Error(`a splat must be a whole last segment (prefix/* or prefix/%*): ${path}`)
  }
  return { kind: 'prefix', path, literal }
}

/**
 * True when a path that starts with `start` and continues freely can still put a `%` after
 * the first character of the segment that begins right after `folder` (start begins with it).
 */
function encodedSegmentPossible(start: string, folder: string): boolean {
  const rest = start.slice(folder.length)
  const slash = rest.indexOf('/')
  // The segment isn't finished yet: whatever follows can supply a first character and a `%`.
  if (slash === -1) return true
  return rest.slice(0, slash).indexOf('%') > 0
}

/**
 * True when some path matches both rules. FXM's rules are exact paths, prefixes ending in `/*`
 * and the two encoded-path guards (`<folder>/%*` and `<folder>/:name%*`), which this decides
 * exactly; anything else is refused.
 */
export function rulesOverlap(a: string, b: string): boolean {
  const left = ruleShape(a)
  const right = ruleShape(b)
  if (left.kind === 'exact' && right.kind === 'exact') return left.path === right.path
  if (left.kind === 'exact' || right.kind === 'exact') {
    const [exact, other] = left.kind === 'exact' ? [left, right] : [right, left]
    return ruleRegExp(other.path).test(exact.path)
  }
  if (left.kind === 'prefix' && right.kind === 'prefix') {
    return left.literal.startsWith(right.literal) || right.literal.startsWith(left.literal)
  }
  if (left.kind === 'encoded' && right.kind === 'encoded') {
    if (left.folder === right.folder) return true
    if (right.folder.startsWith(left.folder))
      return encodedSegmentPossible(right.folder, left.folder)
    if (left.folder.startsWith(right.folder))
      return encodedSegmentPossible(left.folder, right.folder)
    return false
  }
  // One encoded guard and one prefix.
  const [encoded, prefix] = (left.kind === 'encoded' ? [left, right] : [right, left]) as [
    { folder: string },
    { literal: string },
  ]
  if (prefix.literal.startsWith(encoded.folder)) {
    return encodedSegmentPossible(prefix.literal, encoded.folder)
  }
  return encoded.folder.startsWith(prefix.literal)
}
