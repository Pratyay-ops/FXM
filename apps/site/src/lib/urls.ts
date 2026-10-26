/**
 * URL helpers shared by the layout (canonical tags) and the build check.
 *
 * Pages are built as files (`build.format: 'file'`): src/pages/privacy.astro becomes
 * dist/privacy.html, which Cloudflare Pages serves at /privacy. Public URLs therefore
 * have no `.html` and no trailing slash, except the home page `/`.
 */

/** Normalizes a pathname to its public form: `/privacy.html` and `/privacy/` become `/privacy`. */
export function publicPath(pathname: string): string {
  let path = pathname.startsWith('/') ? pathname : `/${pathname}`
  path = path.replace(/\.html$/, '').replace(/\/index$/, '/')
  if (path.length > 1) path = path.replace(/\/+$/, '')
  return path
}

/** The public route of a built HTML file: `index.html` is `/`, `docs/index.html` is `/docs`. */
export function routeForFile(file: string): string {
  return publicPath(`/${file.replace(/\\/g, '/')}`)
}

/** The absolute canonical URL of a page: `canonicalUrl('/privacy/', site)` is `<site>/privacy`. */
export function canonicalUrl(pathname: string, site: string | URL): string {
  return new URL(publicPath(pathname), site).href
}
