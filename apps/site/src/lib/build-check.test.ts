import { describe, expect, it } from 'vitest'
import { checkSite, type Problem } from './build-check'

const SITE = 'https://fxmusic.pages.dev'

interface PageOptions {
  route?: string
  title?: string | null
  description?: string | null
  canonical?: string | null
  head?: string
  body?: string
}

/** A page that passes every check, with parts that a test can replace or drop (null). */
function page({
  route = '/',
  title = 'FXM',
  description = 'A free, open-source music player.',
  canonical,
  head = '',
  body = '<main id="main"><h1>Title</h1></main>',
}: PageOptions = {}): string {
  const url = new URL(route, SITE).href
  const canonicalUrl = canonical === undefined ? url : canonical
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    title === null ? '' : `<title>${title}</title>`,
    description === null ? '' : `<meta name="description" content="${description}">`,
    canonicalUrl === null ? '' : `<link rel="canonical" href="${canonicalUrl}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:title" content="FXM">',
    `<meta property="og:description" content="${description ?? ''}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${SITE}/og.png">`,
    '<meta name="twitter:card" content="summary_large_image">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    head,
    `</head><body>${body}</body></html>`,
  ].join('')
}

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${SITE}/sitemap-0.xml</loc></sitemap></sitemapindex>`

function sitemap(...routes: string[]): string {
  const urls = routes.map((route) => `<url><loc>${new URL(route, SITE).href}</loc></url>`)
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`
}

/** A minimal build that passes: a home page, a privacy page, a 404 page and the extras. */
function build(overrides: Record<string, string | null> = {}): Map<string, string | null> {
  const files = new Map<string, string | null>([
    [
      'index.html',
      page({
        body: '<main id="main"><h1>Home</h1><h2 id="faq">FAQ</h2><a href="/privacy">Privacy</a></main>',
      }),
    ],
    [
      'privacy.html',
      page({ route: '/privacy', body: '<main><h1>Privacy</h1><a href="/#faq">FAQ</a></main>' }),
    ],
    [
      '404.html',
      page({
        route: '/404',
        head: '<meta name="robots" content="noindex">',
        body: '<main><h1>Not found</h1><a href="/">Home page</a></main>',
      }),
    ],
    ['favicon.svg', null],
    ['og.png', null],
    ['robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap-index.xml\n`],
    ['sitemap-index.xml', SITEMAP_INDEX],
    ['sitemap-0.xml', sitemap('/', '/privacy')],
  ])
  for (const [file, text] of Object.entries(overrides)) files.set(file, text)
  return files
}

function check(files: Map<string, string | null>): Problem[] {
  return checkSite({ site: SITE, files, externalPaths: ['/app/'] })
}

/** Problems for one page with the given body, as plain messages. */
function bodyProblems(body: string, head = ''): string[] {
  return check(build({ 'index.html': page({ body, head }), 'privacy.html': null }))
    .filter((problem) => problem.file === 'index.html')
    .map((problem) => problem.message)
}

describe('checkSite', () => {
  it('accepts a complete build', () => {
    expect(check(build())).toEqual([])
  })

  it('reports a build without pages', () => {
    expect(check(new Map([['favicon.svg', null]]))).toEqual([
      { file: '.', message: 'the build contains no pages' },
    ])
  })

  describe('page metadata', () => {
    it('requires a title, a description and a canonical URL', () => {
      const problems = check(
        build({
          'privacy.html': page({
            route: '/privacy',
            title: null,
            description: null,
            canonical: null,
          }),
        }),
      )
      expect(problems).toEqual(
        expect.arrayContaining([
          { file: 'privacy.html', message: 'needs exactly one non-empty <title> (found 0)' },
          {
            file: 'privacy.html',
            message: 'needs exactly one non-empty meta description (found 0)',
          },
          { file: 'privacy.html', message: 'needs exactly one canonical link (found 0)' },
        ]),
      )
    })

    it('rejects an empty title or description', () => {
      const problems = check(
        build({ 'privacy.html': page({ route: '/privacy', title: ' ', description: '' }) }),
      )
      expect(problems.map((problem) => problem.message)).toEqual(
        expect.arrayContaining([
          'needs exactly one non-empty <title> (found 1)',
          'needs exactly one non-empty meta description (found 1)',
        ]),
      )
    })

    it('requires the canonical URL to match the route', () => {
      const problems = check(
        build({ 'privacy.html': page({ route: '/privacy', canonical: `${SITE}/privacy/` }) }),
      )
      expect(problems).toContainEqual({
        file: 'privacy.html',
        message: `canonical is ${SITE}/privacy/, expected ${SITE}/privacy`,
      })
    })

    it('requires lang, viewport and the social card tags', () => {
      const html = page()
        .replace(' lang="en"', '')
        .replace(/<meta name="viewport"[^>]*>/, '')
      const bare = html.replace(/<meta (property|name)="(og|twitter):[^>]*>/g, '')
      const messages = check(build({ 'index.html': bare })).map((problem) => problem.message)
      expect(messages).toEqual(
        expect.arrayContaining([
          '<html> has no lang attribute',
          'missing <meta name="viewport" content="width=device-width, …">',
          'missing og:title meta tag',
          'missing og:image meta tag',
          'missing twitter:card meta tag',
        ]),
      )
    })

    it('requires og:image to be absolute and to exist', () => {
      const relative = page().replace(`content="${SITE}/og.png"`, 'content="/og.png"')
      expect(check(build({ 'index.html': relative })).map((problem) => problem.message)).toContain(
        'og:image must be an absolute URL: /og.png',
      )
      const files = build()
      files.delete('og.png')
      expect(check(files).map((problem) => problem.message)).toContain(
        `og:image points to a missing file: ${SITE}/og.png`,
      )
    })
  })

  describe('structure', () => {
    it('requires one main landmark and one h1', () => {
      expect(bodyProblems('<h1>One</h1><h1>Two</h1>')).toEqual([
        'needs exactly one <main> (found 0)',
        'needs exactly one <h1> (found 2)',
      ])
    })

    it('reports skipped heading levels', () => {
      expect(bodyProblems('<main><h1>Title</h1><h3>Too deep</h3><h2>Fine</h2></main>')).toEqual([
        'heading level skips from h1 to h3',
      ])
    })

    it('reports words glued to links and other inline elements', () => {
      expect(
        bodyProblems(
          '<main><h1>T</h1><p>Read the<a href="/">home page</a>now, <strong>or</strong>\nnot. Open:<code>about:blank</code> and <strong>stop.</strong>Then (<a href="/">see the steps</a>) or the <a href="/">license</a>, run <code>pnpm</code>.</p></main>',
        ),
      ).toEqual([
        'missing space between words: "the<a>home page"',
        'missing space between words: "home page</a>now,"',
        'missing space between words: "Open:<code>about:blank"',
        'missing space between words: "stop.</strong>Then"',
      ])
    })

    it('reports duplicate ids and images without alt text', () => {
      expect(
        bodyProblems(
          '<main id="x"><h1 id="x">Title</h1><img src="/favicon.svg"><img src="/favicon.svg" alt=""></main>',
        ),
      ).toEqual(['duplicate id "x"', '1 <img> without an alt attribute'])
    })
  })

  describe('links', () => {
    it('accepts links to pages, files, fragments, other sites and the web app', () => {
      const body = [
        '<main><h1 id="top">Title</h1>',
        '<a href="/privacy">Privacy</a>',
        '<a href="/privacy.html">Privacy file</a>',
        '<a href="#top">Back to the top</a>',
        '<a href="/#top">Home, top</a>',
        `<a href="${SITE}/favicon.svg">Icon</a>`,
        '<a href="/app/">Open web app</a>',
        '<a href="/app/library">Library</a>',
        '<a href="https://github.com/Pratyay-ops/FXM">FXM on GitHub</a>',
        '<a href="mailto:someone@example.com">Email us</a>',
        '</main>',
      ].join('')
      const files = build({ 'index.html': page({ body }) })
      files.set('privacy.html', page({ route: '/privacy' }))
      expect(check(files)).toEqual([])
    })

    it('reports links to pages and files that are not in the build', () => {
      expect(
        bodyProblems(
          '<main><h1>Title</h1><a href="/blog">Blog</a><a href="/docs/">Docs</a><a href="/%E0%A4%A#%E0">Bad escape</a></main>',
        ),
      ).toEqual([
        'link "Blog" points to /blog, which is not in the build',
        'link "Docs" points to /docs/, which is not in the build',
        'link "Bad escape" points to /%E0%A4%A, which is not in the build',
      ])
    })

    it('reports fragments that do not exist on the target page', () => {
      const files = build()
      files.set(
        'privacy.html',
        page({ route: '/privacy', body: '<main><h1>P</h1><a href="/#nope">FAQ</a></main>' }),
      )
      expect(check(files)).toEqual([
        { file: 'privacy.html', message: 'link "FAQ" points to #nope, which does not exist on /' },
      ])
    })

    it('reports links that go nowhere or run scripts', () => {
      expect(
        bodyProblems(
          '<main><h1>T</h1><a href="#">Top</a><a href="">Empty</a><a href="javascript:void(0)">Run</a></main>',
        ),
      ).toEqual([
        'link "Top" goes nowhere (href="#")',
        'link "Empty" goes nowhere (href="")',
        'link "Run" uses a javascript: URL',
      ])
    })

    it('requires descriptive link text', () => {
      expect(
        bodyProblems(
          '<main><h1>T</h1><a href="/"><svg aria-hidden="true"></svg></a><a href="/">Click here</a><a href="/" aria-label="FXM home"><svg aria-hidden="true"></svg></a><a href="/"><img src="/favicon.svg" alt="FXM home"></a></main>',
        ),
      ).toEqual(['link to / has no text', 'link "Click here" needs more descriptive text'])
    })

    it('requires rel="noopener noreferrer" on links that open a new tab', () => {
      expect(
        bodyProblems(
          '<main><h1>T</h1><a href="https://example.com" target="_blank">Example</a><a href="https://example.com" target=_blank rel=noopener>Unquoted</a><a href="https://example.com" target="_blank" rel="noreferrer noopener">Safe</a></main>',
        ),
      ).toEqual([
        'link "Example" opens a new tab without rel="noopener noreferrer"',
        'link "Unquoted" opens a new tab without rel="noopener noreferrer"',
      ])
    })
  })

  describe('scripts, styles and icons', () => {
    it('accepts inline scripts and files from the site', () => {
      const files = build({
        'index.html': page({
          head: '<link rel="stylesheet" href="/_astro/site.css"><script type="module" src="/_astro/app.js"></script>',
          body: '<main><h1>T</h1><h2 id="faq">FAQ</h2><script>console.log(1)</script></main>',
        }),
        '_astro/site.css': null,
        '_astro/app.js': null,
      })
      expect(check(files)).toEqual([])
    })

    it('rejects third-party scripts, stylesheets and fonts', () => {
      expect(
        bodyProblems(
          '<main><h1>T</h1></main>',
          '<script src="https://cdn.example.com/analytics.js"></script><link rel="stylesheet" href="https://fonts.example.com/css"><link rel="preload" href="//fonts.example.com/font.woff2" as="font">',
        ),
      ).toEqual([
        'third-party script https://cdn.example.com/analytics.js; serve it from the site',
        'third-party link https://fonts.example.com/css; serve it from the site',
        'third-party link https://fonts.example.com/font.woff2; serve it from the site',
      ])
    })

    it('reports missing local files', () => {
      expect(
        bodyProblems('<main><h1>T</h1></main>', '<script src="/_astro/gone.js"></script>'),
      ).toEqual(['script points to a missing file: /_astro/gone.js'])
    })
  })

  describe('sitemap and robots.txt', () => {
    it('requires every indexable page in the sitemap, and only those', () => {
      const problems = check(build({ 'sitemap-0.xml': sitemap('/', '/404', '/gone') }))
      expect(problems).toEqual([
        { file: 'privacy.html', message: `missing from the sitemap: ${SITE}/privacy` },
        {
          file: 'sitemap-index.xml',
          message: `sitemap lists ${SITE}/404, which is not an indexable page`,
        },
        {
          file: 'sitemap-index.xml',
          message: `sitemap lists ${SITE}/gone, which is not an indexable page`,
        },
      ])
    })

    it('requires a sitemap and a robots.txt that points to it', () => {
      const files = build({ 'robots.txt': 'User-agent: *\nAllow: /\n' })
      files.delete('sitemap-index.xml')
      expect(check(files)).toEqual([
        {
          file: 'robots.txt',
          message: `robots.txt must contain "Sitemap: ${SITE}/sitemap-index.xml"`,
        },
        { file: 'sitemap-index.xml', message: 'sitemap-index.xml is missing' },
      ])
    })
  })
})
