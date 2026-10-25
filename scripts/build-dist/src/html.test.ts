import { describe, expect, it } from 'vitest'
import {
  decodeEntities,
  elementTexts,
  insertIntoHead,
  normalizeNewlines,
  scanPage,
  tokenize,
} from './html.ts'

describe('tokenize', () => {
  it('reads tags, quoted and unquoted attributes, and text', () => {
    const tokens = tokenize(`<a href="/x" data-y='1' z=2 hidden>Hi</a>`)
    expect(tokens).toEqual([
      {
        type: 'start',
        name: 'a',
        attributes: new Map([
          ['href', '/x'],
          ['data-y', '1'],
          ['z', '2'],
          ['hidden', ''],
        ]),
      },
      { type: 'text', text: 'Hi', raw: false },
      { type: 'end', name: 'a' },
    ])
  })

  it('keeps the first of repeated attributes and lower-cases names', () => {
    const [tag] = tokenize('<IMG SRC="a" src="b">')
    expect(tag).toEqual({ type: 'start', name: 'img', attributes: new Map([['src', 'a']]) })
  })

  it('reads raw text up to the matching end tag only', () => {
    const tokens = tokenize('<script>if (a < b && "</scripts>") {}</script ><p>after</p>')
    expect(tokens[1]).toEqual({ type: 'text', text: 'if (a < b && "</scripts>") {}', raw: true })
    expect(tokens[2]).toEqual({ type: 'end', name: 'script' })
    expect(tokens[3]).toMatchObject({ type: 'start', name: 'p' })
  })

  it('skips comments, doctypes and markup inside comments', () => {
    const tokens = tokenize('<!doctype html><!-- <script>x()</script> --><b>ok</b>')
    expect(tokens.map((token) => token.type)).toEqual(['start', 'text', 'end'])
  })

  it('treats "<" that starts no tag as text', () => {
    expect(tokenize('1 < 2')).toEqual([{ type: 'text', text: '1 < 2', raw: false }])
  })

  it('runs an unterminated raw-text element to the end of the document', () => {
    expect(tokenize('<style>a{}')[1]).toEqual({ type: 'text', text: 'a{}', raw: true })
  })

  it('finds end tags after letters that lower-case to more characters, such as İ', () => {
    // 'İ'.toLowerCase() is two UTF-16 units: indices into a lower-cased copy would drift.
    expect(scanPage('<title>İstanbul</title><script>menu()</script>').inlineScripts).toEqual([
      'menu()',
    ])
    const scan = scanPage('<p>İİ</p><style>h1{}</style><script>menu()</script>')
    expect(scan.inlineStyles).toEqual(['h1{}'])
    expect(scan.inlineScripts).toEqual(['menu()'])
  })

  it('matches end tags in any case, and only whole tag names', () => {
    const tokens = tokenize('<SCRIPT>a("</scripty>")</ScRiPt\n><p>')
    expect(tokens[1]).toEqual({ type: 'text', text: 'a("</scripty>")', raw: true })
    expect(tokens[3]).toMatchObject({ type: 'start', name: 'p' })
  })
})

describe('normalizeNewlines', () => {
  it('turns CR LF and CR into LF and drops a byte order mark, as browsers do', () => {
    expect(normalizeNewlines('﻿a\r\nb\rc\n')).toBe('a\nb\nc\n')
  })
})

describe('scanPage', () => {
  it('finds inline code, loaded scripts and styles, and what a policy cannot fix', () => {
    const scan = scanPage(`<!doctype html><html><head>
      <meta name="referrer" content="origin">
      <script>theme()</script>
      <script type="module" crossorigin src="/app/assets/index.js"></script>
      <link rel="modulepreload" href="/app/assets/chunk.js">
      <link rel="stylesheet" href="/app/assets/index.css">
      <link rel="preload" as="style" href="/app/assets/late.css">
      <link rel="icon" href="/favicon.svg">
      <style>body{}</style>
    </head><body style="margin:0"><button onclick="go()">Go</button><a href="javascript:void 0">x</a></body></html>`)
    expect(scan).toEqual({
      inlineScripts: ['theme()'],
      inlineStyles: ['body{}'],
      scriptUrls: ['/app/assets/index.js'],
      stylesheetUrls: ['/app/assets/index.css', '/app/assets/late.css'],
      modulePreloadUrls: ['/app/assets/chunk.js'],
      styleAttributes: ['body'],
      eventHandlers: ['button[onclick]'],
      javascriptUrls: ['a[href]'],
      referrerMetas: ['origin'],
      metaPolicies: [],
    })
  })

  it('reads an empty inline script as empty', () => {
    expect(scanPage('<script></script>').inlineScripts).toEqual([''])
  })

  it('reads policies in meta elements, decoded, and whether they precede every script', () => {
    const scan = scanPage(
      `<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;"><script>a()</script><meta HTTP-EQUIV="content-security-policy" content="img-src 'self'">`,
    )
    expect(scan.metaPolicies).toEqual([
      { content: "default-src 'none'", beforeScripts: true },
      { content: "img-src 'self'", beforeScripts: false },
    ])
  })
})

describe('elementTexts', () => {
  it('collects the text of elements, without tags, with entities decoded', () => {
    const html = '<dl><dt><a href="/">YouTube</a></dt><dd>x</dd><dt> Spotify &amp;\n key </dt></dl>'
    expect(elementTexts(html, 'dt')).toEqual(['YouTube', 'Spotify & key'])
  })
})

describe('decodeEntities', () => {
  it('decodes named and numeric references and leaves unknown ones', () => {
    expect(decodeEntities('&lt;&#39;&#x41;&nbsp;&unknown;')).toBe("<'A &unknown;")
  })
})

describe('insertIntoHead', () => {
  it('inserts after the charset, which must stay in the first 1,024 bytes, or after <head>', () => {
    expect(insertIntoHead('<html><head>\r\n<meta charset=utf-8><title>t</title>', '<x>')).toBe(
      '<html><head>\n<meta charset=utf-8><x><title>t</title>',
    )
    expect(insertIntoHead('<HEAD class="a"><title>t</title><meta charset="utf-8">', '<x>')).toBe(
      '<HEAD class="a"><title>t</title><meta charset="utf-8"><x>',
    )
    expect(insertIntoHead('<head><title>t</title></head><meta charset="utf-8">', '<x>')).toBe(
      '<head><x><title>t</title></head><meta charset="utf-8">',
    )
  })

  it('needs a head tag, and ignores one in a comment', () => {
    expect(() => insertIntoHead('<!-- <head> --><title>t</title>', '<x>')).toThrow(/no <head> tag/)
  })
})
