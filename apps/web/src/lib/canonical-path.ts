/**
 * The app's address with its base spelled out, for an address whose base is percent-encoded.
 *
 * Cloudflare Pages serves `/%61pp/` as `/app/` but applies no `_headers` rule to it (rules
 * can't match a path with an encoded letter, see `scripts/build-dist/README.md`), so the app
 * would run without its `frame-ancestors` and its other headers there. `main.tsx` therefore
 * sends such an address to its plain spelling before anything starts.
 *
 * @module
 */

/**
 * The plain spelling of `pathname` when its decoded form starts with `base` but `pathname`
 * itself doesn't (an encoded base, such as `/%61pp/` for `/app/`), else `undefined`. Only the
 * base is decoded, so an encoded character after it, such as a `%2F` inside an ID, stays as it
 * was. An address that isn't valid percent-encoding is left alone.
 */
export function canonicalAppPath(pathname: string, base: string): string | undefined {
  if (pathname.startsWith(base)) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (!decoded.startsWith(base)) return undefined
  // The shortest prefix that decodes to the base: an escape is at most 3 characters per byte.
  for (let end = base.length; end <= Math.min(pathname.length, base.length * 3); end += 1) {
    let prefix: string
    try {
      prefix = decodeURIComponent(pathname.slice(0, end))
    } catch {
      continue
    }
    if (prefix === base) return `${base}${pathname.slice(end)}`
  }
  return undefined
}
