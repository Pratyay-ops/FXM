/**
 * A small HTML tokenizer: just enough of the HTML parsing rules to find the inline scripts and
 * styles a Content-Security-Policy must allow by hash, the resources a page loads, and the text
 * of a few elements (the privacy page's service names).
 *
 * It follows the parts of the HTML standard that decide what a browser hashes: line endings are
 * normalized to LF before tokenizing, comments are skipped, attribute values may be quoted or
 * unquoted, and the content of raw-text elements (`<script>`, `<style>`, …) runs to the first
 * matching end tag. It ignores the rare "escaped script data" state (`<!--` followed by
 * `<script` inside a script), which the builds FXM ships don't produce.
 */

export interface StartTag {
  type: 'start'
  /** Lower-case tag name. */
  name: string
  /** Lower-case attribute names; boolean attributes have the value ''. The first one wins. */
  attributes: ReadonlyMap<string, string>
}

export interface EndTag {
  type: 'end'
  name: string
}

export interface Text {
  type: 'text'
  /** Raw text, entities not decoded. For raw-text elements, exactly what a browser hashes. */
  text: string
  /** True for the content of a raw-text element such as `<script>` or `<style>`. */
  raw: boolean
}

export type Token = StartTag | EndTag | Text

/** Elements whose content is text up to their end tag (raw text and escapable raw text). */
const RAW_TEXT = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  // Parsed as raw text when scripting is on, as it is for every visitor that runs the app.
  'noscript',
])

const SPACE = /[\t\n\f\r ]/

/** Normalizes line endings and drops a byte order mark, as browsers do before tokenizing. */
export function normalizeNewlines(html: string): string {
  return html.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

function isLetter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z]/.test(char)
}

/** Splits an HTML document into start tags, end tags and text. */
export function tokenize(input: string): Token[] {
  const html = normalizeNewlines(input)
  const tokens: Token[] = []
  let i = 0
  let textStart = 0

  const flushText = (end: number) => {
    if (end > textStart) tokens.push({ type: 'text', text: html.slice(textStart, end), raw: false })
  }

  while (i < html.length) {
    if (html[i] !== '<') {
      i++
      continue
    }
    const next = html[i + 1]
    if (html.startsWith('<!--', i)) {
      flushText(i)
      const end = html.indexOf('-->', i + 4)
      i = end === -1 ? html.length : end + 3
      textStart = i
    } else if (next === '!' || next === '?') {
      // Doctype, CDATA or a bogus comment: skipped up to the next '>'.
      flushText(i)
      const end = html.indexOf('>', i + 2)
      i = end === -1 ? html.length : end + 1
      textStart = i
    } else if (next === '/' && isLetter(html[i + 2])) {
      flushText(i)
      const nameEnd = scanName(html, i + 2)
      tokens.push({ type: 'end', name: html.slice(i + 2, nameEnd).toLowerCase() })
      const end = html.indexOf('>', nameEnd)
      i = end === -1 ? html.length : end + 1
      textStart = i
    } else if (isLetter(next)) {
      flushText(i)
      const tag = readStartTag(html, i)
      tokens.push(tag.token)
      i = tag.end
      textStart = i
      // In HTML a slash doesn't close `<script/>`: a raw-text element always runs to its end tag.
      if (RAW_TEXT.has(tag.token.name)) {
        const close = findEndTag(html, i, tag.token.name)
        tokens.push({ type: 'text', text: html.slice(i, close.contentEnd), raw: true })
        tokens.push({ type: 'end', name: tag.token.name })
        i = close.end
        textStart = i
      }
    } else {
      i++
    }
  }
  flushText(html.length)
  return tokens
}

function scanName(html: string, start: number): number {
  let end = start
  while (
    end < html.length &&
    !SPACE.test(html[end] as string) &&
    !'/>'.includes(html[end] as string)
  ) {
    end++
  }
  return end
}

function readStartTag(html: string, start: number): { token: StartTag; end: number } {
  const nameEnd = scanName(html, start + 1)
  const name = html.slice(start + 1, nameEnd).toLowerCase()
  const attributes = new Map<string, string>()
  let i = nameEnd
  while (i < html.length) {
    const char = html[i] as string
    if (SPACE.test(char) || char === '/') {
      i++
    } else if (char === '>') {
      i++
      break
    } else {
      let nameStop = i
      while (nameStop < html.length && !/[\t\n\f\r />=]/.test(html[nameStop] as string)) nameStop++
      // An attribute name may start with '=' (a parse error browsers accept).
      if (nameStop === i) nameStop++
      const attribute = html.slice(i, nameStop).toLowerCase()
      i = nameStop
      while (i < html.length && SPACE.test(html[i] as string)) i++
      let value = ''
      if (html[i] === '=') {
        i++
        while (i < html.length && SPACE.test(html[i] as string)) i++
        const quote = html[i]
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, i + 1)
          const stop = close === -1 ? html.length : close
          value = html.slice(i + 1, stop)
          i = close === -1 ? html.length : close + 1
        } else {
          let stop = i
          while (stop < html.length && !/[\t\n\f\r >]/.test(html[stop] as string)) stop++
          value = html.slice(i, stop)
          i = stop
        }
      }
      if (!attributes.has(attribute)) attributes.set(attribute, value)
    }
  }
  return { token: { type: 'start', name, attributes }, end: i }
}

/**
 * The end tag that closes a raw-text element: `</name` in any case, followed by a space, `/`,
 * `>` or the end of the document. Searched in the original string, because lower-casing it
 * can change its length (`İ` becomes two characters) and so every index after it.
 */
function findEndTag(html: string, from: number, name: string): { contentEnd: number; end: number } {
  const endTag = new RegExp(`</${name}(?=[\\t\\n\\f\\r />]|$)`, 'gi')
  endTag.lastIndex = from
  const match = endTag.exec(html)
  if (!match) return { contentEnd: html.length, end: html.length }
  const close = html.indexOf('>', match.index)
  return { contentEnd: match.index, end: close === -1 ? html.length : close + 1 }
}

/** What a page contains that its Content-Security-Policy has to account for. */
export interface PageScan {
  /** Contents of every `<script>` without `src`, in document order. */
  inlineScripts: string[]
  /** Contents of every `<style>` element, in document order. */
  inlineStyles: string[]
  /** `src` of every `<script src>`. */
  scriptUrls: string[]
  /** `href` of every `<link rel="stylesheet">` (and `rel="preload" as="style"`). */
  stylesheetUrls: string[]
  /** `href` of every `<link rel="modulepreload">`, which script-src governs too. */
  modulePreloadUrls: string[]
  /** Tag names of elements with a `style` attribute. */
  styleAttributes: string[]
  /** `tag[attribute]` for every inline event handler, such as `button[onclick]`. */
  eventHandlers: string[]
  /** Attributes whose value is a `javascript:` URL. */
  javascriptUrls: string[]
  /** `content` of every `<meta name="referrer">`, which would override Referrer-Policy. */
  referrerMetas: string[]
  /**
   * Every `<meta http-equiv="Content-Security-Policy">`, with whether it comes before the
   * page's first script (a policy in a meta element governs only what follows it).
   */
  metaPolicies: { content: string; beforeScripts: boolean }[]
}

/** Scans a page for inline code and the scripts and styles it loads. */
export function scanPage(html: string): PageScan {
  const scan: PageScan = {
    inlineScripts: [],
    inlineStyles: [],
    scriptUrls: [],
    stylesheetUrls: [],
    modulePreloadUrls: [],
    styleAttributes: [],
    eventHandlers: [],
    javascriptUrls: [],
    referrerMetas: [],
    metaPolicies: [],
  }
  const tokens = tokenize(html)
  let seenScript = false
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as Token
    if (token.type !== 'start') continue
    const { name, attributes } = token
    for (const [attribute, value] of attributes) {
      if (attribute === 'style') scan.styleAttributes.push(name)
      if (attribute.startsWith('on')) scan.eventHandlers.push(`${name}[${attribute}]`)
      if (/^\s*javascript:/i.test(value)) scan.javascriptUrls.push(`${name}[${attribute}]`)
    }
    if (name === 'script') seenScript = true
    if (name === 'script' || name === 'style') {
      const content = tokens[index + 1]
      const text = content?.type === 'text' && content.raw ? content.text : ''
      if (name === 'style') scan.inlineStyles.push(text)
      else if (attributes.has('src')) scan.scriptUrls.push(attributes.get('src') ?? '')
      else scan.inlineScripts.push(text)
    } else if (name === 'link') {
      const rel = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/)
      const href = attributes.get('href') ?? ''
      if (rel.includes('stylesheet')) scan.stylesheetUrls.push(href)
      else if (rel.includes('preload') && attributes.get('as')?.toLowerCase() === 'style') {
        scan.stylesheetUrls.push(href)
      } else if (rel.includes('modulepreload')) scan.modulePreloadUrls.push(href)
    } else if (name === 'meta' && attributes.get('name')?.toLowerCase() === 'referrer') {
      scan.referrerMetas.push(attributes.get('content') ?? '')
    } else if (
      name === 'meta' &&
      attributes.get('http-equiv')?.trim().toLowerCase() === 'content-security-policy'
    ) {
      scan.metaPolicies.push({
        content: decodeEntities(attributes.get('content') ?? ''),
        beforeScripts: !seenScript,
      })
    }
  }
  return scan
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Decodes the character references FXM's pages use: the named basics and numeric ones. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[ref.toLowerCase()] ?? match
  })
}

/** Text content of every `<name>` element (tags stripped, entities decoded, spaces collapsed). */
export function elementTexts(html: string, name: string): string[] {
  const texts: string[] = []
  let depth = 0
  let current = ''
  for (const token of tokenize(html)) {
    if (token.type === 'start' && token.name === name) {
      if (depth === 0) current = ''
      depth++
    } else if (token.type === 'end' && token.name === name && depth > 0) {
      depth--
      if (depth === 0) texts.push(decodeEntities(current).replace(/\s+/g, ' ').trim())
    } else if (token.type === 'text' && depth > 0) {
      current += token.text
    }
  }
  return texts
}
