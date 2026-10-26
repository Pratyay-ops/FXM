/**
 * Checks the built site before it can ship. src/integrations/build-check.ts runs this
 * after every `astro build` and fails the build on any problem, so a page without a
 * description or a broken link never reaches the deploy step.
 *
 * Every page must have: a lang attribute, a viewport, one title, one description, a
 * canonical URL that matches its route, Open Graph and Twitter tags, one main landmark,
 * one h1 and no skipped heading levels, unique ids, and alt text on images.
 * Every link must resolve (fragments included), carry descriptive text, and open new
 * tabs only with rel="noopener noreferrer". No word may be glued to a link or other
 * inline element. Scripts, styles and icons must come from the site itself. The sitemap
 * must list exactly the indexable pages, and robots.txt must point to it.
 */
import { type DefaultTreeAdapterTypes, parse } from 'parse5'
import { routeForFile } from './urls'

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element

export interface Problem {
  /** The file the problem is in, relative to the build output. */
  file: string
  message: string
}

export interface SiteInput {
  /** Origin the site is served from, such as https://fxmusic.pages.dev. */
  site: string
  /**
   * Every file in the build output, keyed by its path relative to the output folder with
   * forward slashes (`index.html`, `_astro/a.css`). Values hold the text of .html, .xml and
   * .txt files and null for everything else.
   */
  files: ReadonlyMap<string, string | null>
  /** Path prefixes that something else serves at deploy time, such as the web app at /app/. */
  externalPaths?: readonly string[] | undefined
}

interface Link {
  tag: string
  /** The attribute value as written. */
  value: string
  url: URL | null
}

interface Page {
  file: string
  url: URL
  ids: Set<string>
  duplicateIds: Set<string>
  lang: string
  hasViewport: boolean
  titles: string[]
  descriptions: string[]
  canonicals: string[]
  meta: Map<string, string>
  noindex: boolean
  mainCount: number
  headings: number[]
  anchors: { href: string; url: URL | null; name: string; target: string; rel: string[] }[]
  resources: Link[]
  imagesWithoutAlt: number
  /** Inline elements glued to the next or previous word, such as "the<a>license</a>". */
  gluedWords: string[]
}

const GENERIC_LINK_TEXT = new Set([
  'click here',
  'here',
  'learn more',
  'link',
  'more',
  'read more',
  'this page',
])

const RESOURCE_RELS = new Set([
  'apple-touch-icon',
  'icon',
  'manifest',
  'modulepreload',
  'preload',
  'sitemap',
  'stylesheet',
])

/** Inline elements that sit inside running text. */
const INLINE_TEXT = new Set(['a', 'abbr', 'b', 'code', 'em', 'i', 'kbd', 'strong', 'time'])

const REQUIRED_SOCIAL_TAGS = [
  'og:type',
  'og:title',
  'og:description',
  'og:url',
  'og:image',
  'twitter:card',
] as const

function isElement(node: Node): node is Element {
  return 'tagName' in node
}

function childrenOf(node: Node): Node[] {
  const children: Node[] = 'childNodes' in node ? [...node.childNodes] : []
  if ('content' in node && node.content) children.push(node.content)
  return children
}

function* elementsOf(node: Node): Generator<Element> {
  if (isElement(node)) yield node
  for (const child of childrenOf(node)) yield* elementsOf(child)
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Visible text, skipping scripts, styles and anything hidden from assistive technology. */
function textOf(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value
  if (isElement(node)) {
    if (node.tagName === 'script' || node.tagName === 'style') return ''
    if (attr(node, 'aria-hidden') === 'true' || attr(node, 'hidden') !== undefined) return ''
  }
  return childrenOf(node).map(textOf).join('')
}

/**
 * Finds words glued to an inline element, which renders as "the<a>license</a>". Formatters
 * break lines at inline elements, so a whitespace setting that drops line breaks (Astro's
 * `compressHTML: 'jsx'`) would silently glue words together.
 */
function gluedWords(element: Element): string[] {
  const parent = element.parentNode
  const siblings = parent && 'childNodes' in parent ? parent.childNodes : []
  const index = siblings.indexOf(element)
  const text = collapse(textOf(element))
  const before = siblings[index - 1]
  const after = siblings[index + 1]
  // A word or the end of a sentence, directly followed by a word.
  const end = /[\p{L}\p{N}.,:;!?]$/u
  const start = /^[\p{L}\p{N}]/u
  const glued: string[] = []
  if (
    before?.nodeName === '#text' &&
    'value' in before &&
    end.test(before.value) &&
    start.test(text)
  ) {
    glued.push(`"${before.value.trim().split(/\s+/).pop()}<${element.tagName}>${text}"`)
  }
  if (
    after?.nodeName === '#text' &&
    'value' in after &&
    end.test(text) &&
    start.test(after.value)
  ) {
    glued.push(`"${text}</${element.tagName}>${after.value.trim().split(/\s+/)[0]}"`)
  }
  return glued
}

/** A link's accessible name: aria-label, its text, or the text alternative of an image in it. */
function accessibleName(element: Element): string {
  const label = attr(element, 'aria-label')
  if (label?.trim()) return collapse(label)
  const text = collapse(textOf(element))
  if (text) return text
  for (const child of elementsOf(element)) {
    const alternative = child.tagName === 'img' ? attr(child, 'alt') : attr(child, 'aria-label')
    if (alternative?.trim() && attr(child, 'aria-hidden') !== 'true') return collapse(alternative)
  }
  return ''
}

/** decodeURIComponent that keeps malformed input as it is instead of throwing. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function toUrl(value: string, base: URL): URL | null {
  try {
    return new URL(value, base)
  } catch {
    return null
  }
}

function analyze(file: string, html: string, site: string): Page {
  const url = new URL(routeForFile(file), site)
  const page: Page = {
    file,
    url,
    ids: new Set(),
    duplicateIds: new Set(),
    lang: '',
    hasViewport: false,
    titles: [],
    descriptions: [],
    canonicals: [],
    meta: new Map(),
    noindex: false,
    mainCount: 0,
    headings: [],
    anchors: [],
    resources: [],
    imagesWithoutAlt: 0,
    gluedWords: [],
  }

  for (const element of elementsOf(parse(html))) {
    const id = attr(element, 'id')
    if (id) {
      if (page.ids.has(id)) page.duplicateIds.add(id)
      page.ids.add(id)
    }
    const name = attr(element, 'name')
    if (element.tagName === 'a' && name) page.ids.add(name)
    if (INLINE_TEXT.has(element.tagName)) page.gluedWords.push(...gluedWords(element))

    switch (element.tagName) {
      case 'html':
        page.lang = attr(element, 'lang')?.trim() ?? ''
        break
      case 'title':
        page.titles.push(collapse(textOf(element)))
        break
      case 'meta': {
        const key = attr(element, 'name') ?? attr(element, 'property')
        const content = collapse(attr(element, 'content') ?? '')
        if (key === 'description') page.descriptions.push(content)
        else if (key === 'viewport') page.hasViewport = content.includes('width=device-width')
        else if (key === 'robots') page.noindex = /\bnoindex\b/i.test(content)
        if (key && !page.meta.has(key)) page.meta.set(key, content)
        break
      }
      case 'link': {
        const href = attr(element, 'href') ?? ''
        const rels = (attr(element, 'rel') ?? '').toLowerCase().split(/\s+/)
        if (rels.includes('canonical')) page.canonicals.push(href)
        if (rels.some((rel) => RESOURCE_RELS.has(rel))) {
          page.resources.push({ tag: 'link', value: href, url: toUrl(href, url) })
        }
        break
      }
      case 'script':
      case 'img': {
        const src = attr(element, 'src')
        if (src !== undefined) {
          page.resources.push({ tag: element.tagName, value: src, url: toUrl(src, url) })
        }
        if (element.tagName === 'img' && attr(element, 'alt') === undefined) page.imagesWithoutAlt++
        break
      }
      case 'main':
        page.mainCount++
        break
      case 'a': {
        const href = attr(element, 'href')
        if (href === undefined) break
        page.anchors.push({
          href,
          url: toUrl(href, url),
          name: accessibleName(element),
          target: attr(element, 'target') ?? '',
          rel: (attr(element, 'rel') ?? '').toLowerCase().split(/\s+/),
        })
        break
      }
      default:
        if (/^h[1-6]$/.test(element.tagName)) page.headings.push(Number(element.tagName[1]))
    }
  }
  return page
}

/** The built file a same-site path is served from, following Cloudflare Pages' rules. */
function resolveFile(pathname: string, files: ReadonlyMap<string, unknown>): string | undefined {
  const path = decode(pathname).replace(/^\/+/, '')
  const candidates =
    path === '' || path.endsWith('/')
      ? [`${path}index.html`]
      : [path, `${path}.html`, `${path}/index.html`]
  return candidates.find((candidate) => files.has(candidate))
}

function checkPage(page: Page, pages: Map<string, Page>, input: SiteInput): string[] {
  const problems: string[] = []
  const origin = new URL(input.site).origin
  const external = input.externalPaths ?? []

  // Document basics
  if (!page.lang) problems.push('<html> has no lang attribute')
  if (!page.hasViewport) {
    problems.push('missing <meta name="viewport" content="width=device-width, …">')
  }
  if (page.titles.length !== 1 || !page.titles[0]) {
    problems.push(`needs exactly one non-empty <title> (found ${page.titles.length})`)
  }
  if (page.descriptions.length !== 1 || !page.descriptions[0]) {
    problems.push(
      `needs exactly one non-empty meta description (found ${page.descriptions.length})`,
    )
  }

  // Canonical URL and social cards
  const expected = page.url.href
  if (page.canonicals.length !== 1) {
    problems.push(`needs exactly one canonical link (found ${page.canonicals.length})`)
  } else if (page.canonicals[0] !== expected) {
    problems.push(`canonical is ${page.canonicals[0]}, expected ${expected}`)
  }
  for (const tag of REQUIRED_SOCIAL_TAGS) {
    if (!page.meta.get(tag)) problems.push(`missing ${tag} meta tag`)
  }
  const ogUrl = page.meta.get('og:url')
  if (ogUrl && ogUrl !== expected) problems.push(`og:url is ${ogUrl}, expected ${expected}`)
  for (const tag of ['og:image', 'twitter:image']) {
    const value = page.meta.get(tag)
    if (!value) continue
    const url = toUrl(value, page.url)
    if (!url || !/^https?:\/\//.test(value)) {
      problems.push(`${tag} must be an absolute URL: ${value}`)
    } else if (url.origin === origin && !resolveFile(url.pathname, input.files)) {
      problems.push(`${tag} points to a missing file: ${value}`)
    }
  }

  // Structure
  if (page.mainCount !== 1) problems.push(`needs exactly one <main> (found ${page.mainCount})`)
  const h1s = page.headings.filter((level) => level === 1).length
  if (h1s !== 1) problems.push(`needs exactly one <h1> (found ${h1s})`)
  let previous = 0
  for (const level of page.headings) {
    if (level > previous + 1) {
      problems.push(
        `heading level skips from ${previous ? `h${previous}` : 'the start'} to h${level}`,
      )
    }
    previous = level
  }
  for (const id of page.duplicateIds) problems.push(`duplicate id "${id}"`)
  if (page.imagesWithoutAlt) {
    problems.push(`${page.imagesWithoutAlt} <img> without an alt attribute`)
  }
  for (const glued of page.gluedWords) problems.push(`missing space between words: ${glued}`)

  // Scripts, styles and icons come from this site and exist
  for (const resource of page.resources) {
    if (!resource.url) {
      problems.push(`invalid ${resource.tag} URL "${resource.value}"`)
    } else if (resource.url.origin !== origin) {
      problems.push(`third-party ${resource.tag} ${resource.url.href}; serve it from the site`)
    } else if (!resolveFile(resource.url.pathname, input.files)) {
      problems.push(`${resource.tag} points to a missing file: ${resource.value}`)
    }
  }

  // Links
  for (const anchor of page.anchors) {
    const label = `link "${anchor.name || anchor.href}"`
    if (!anchor.name) problems.push(`link to ${anchor.href} has no text`)
    else if (GENERIC_LINK_TEXT.has(anchor.name.toLowerCase())) {
      problems.push(`${label} needs more descriptive text`)
    }
    if (
      anchor.target === '_blank' &&
      !(anchor.rel.includes('noopener') && anchor.rel.includes('noreferrer'))
    ) {
      problems.push(`${label} opens a new tab without rel="noopener noreferrer"`)
    }
    if (anchor.href.trim() === '' || anchor.href.trim() === '#') {
      problems.push(`${label} goes nowhere (href="${anchor.href}")`)
      continue
    }
    const url = anchor.url
    if (!url) {
      problems.push(`${label} has an invalid URL`)
      continue
    }
    if (url.protocol === 'javascript:') {
      problems.push(`${label} uses a javascript: URL`)
      continue
    }
    if (url.origin !== origin) continue // other sites and mailto: are not checked offline
    if (external.some((prefix) => url.pathname.startsWith(prefix))) continue

    const file = resolveFile(url.pathname, input.files)
    if (!file) {
      problems.push(`${label} points to ${url.pathname}, which is not in the build`)
      continue
    }
    const fragment = decode(url.hash.slice(1))
    if (fragment) {
      const target = pages.get(file)
      if (!target) problems.push(`${label} has a #fragment but ${file} is not a page`)
      else if (!target.ids.has(fragment)) {
        problems.push(
          `${label} points to #${fragment}, which does not exist on ${target.url.pathname}`,
        )
      }
    }
  }
  return problems
}

function checkSitemap(pages: Page[], input: SiteInput): Problem[] {
  const problems: Problem[] = []
  const sitemapUrl = new URL('/sitemap-index.xml', input.site).href
  const robots = input.files.get('robots.txt')
  if (typeof robots !== 'string') {
    problems.push({ file: 'robots.txt', message: 'robots.txt is missing' })
  } else if (!robots.split('\n').some((line) => line.trim() === `Sitemap: ${sitemapUrl}`)) {
    problems.push({
      file: 'robots.txt',
      message: `robots.txt must contain "Sitemap: ${sitemapUrl}"`,
    })
  }

  if (!input.files.has('sitemap-index.xml')) {
    problems.push({ file: 'sitemap-index.xml', message: 'sitemap-index.xml is missing' })
    return problems
  }
  const listed = new Set<string>()
  for (const [file, text] of input.files) {
    if (
      file === 'sitemap-index.xml' ||
      !/^sitemap-.*\.xml$/.test(file) ||
      typeof text !== 'string'
    ) {
      continue
    }
    for (const match of text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      if (match[1]) listed.add(match[1].replace(/&amp;/g, '&'))
    }
  }
  const indexable = new Map(
    pages.filter((page) => !page.noindex).map((page) => [page.url.href, page]),
  )
  for (const [url, page] of indexable) {
    if (!listed.has(url)) {
      problems.push({ file: page.file, message: `missing from the sitemap: ${url}` })
    }
  }
  for (const url of listed) {
    if (!indexable.has(url)) {
      problems.push({
        file: 'sitemap-index.xml',
        message: `sitemap lists ${url}, which is not an indexable page`,
      })
    }
  }
  return problems
}

/** Checks every page, link and resource of a built site. An empty array means it is ready. */
export function checkSite(input: SiteInput): Problem[] {
  const pages = new Map<string, Page>()
  for (const [file, text] of input.files) {
    if (file.endsWith('.html') && typeof text === 'string') {
      pages.set(file, analyze(file, text, input.site))
    }
  }
  const problems: Problem[] = []
  if (pages.size === 0) return [{ file: '.', message: 'the build contains no pages' }]
  for (const page of pages.values()) {
    for (const message of checkPage(page, pages, input)) problems.push({ file: page.file, message })
  }
  problems.push(...checkSitemap([...pages.values()], input))
  return problems
}
