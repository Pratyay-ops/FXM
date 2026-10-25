import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  inlineScripts,
  sandboxDocumentHeader,
  sandboxDocumentPolicy,
  sha256Source,
} from '../csp.ts'
import {
  SANDBOX_MARKER_ATTRIBUTE,
  SANDBOX_MESSAGE,
  SANDBOX_PROTOCOL,
  type SandboxDocumentKind,
} from '../document.ts'
import {
  compactStrippedSource,
  DOCUMENTS_DIR,
  renderSandboxDocument,
  SANDBOX_DOCUMENT_FILES,
  stripTypes,
  toDocumentScript,
} from './render.ts'

const KINDS = Object.keys(SANDBOX_DOCUMENT_FILES) as SandboxDocumentKind[]
const FXM = 'https://fxm-music.pages.dev'

const committed = (kind: SandboxDocumentKind) =>
  readFile(join(DOCUMENTS_DIR, SANDBOX_DOCUMENT_FILES[kind].file), 'utf8')

describe('the committed sandbox documents', () => {
  it.each(KINDS)(
    '%s is current: run `pnpm --filter @fxm/platform sandbox:build` if not',
    async (kind) => {
      expect(await committed(kind)).toBe(await renderSandboxDocument(kind))
    },
  )

  it.each(KINDS)('%s carries a policy that allows exactly its one inline script', async (kind) => {
    const html = await committed(kind)
    const scripts = inlineScripts(html)
    expect(scripts).toHaveLength(1)
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1]
    const hash = await sha256Source(scripts[0] ?? '')
    expect(meta).toBe(sandboxDocumentPolicy(kind, [hash], { sandbox: false }))
    expect(await sandboxDocumentHeader(kind, html)).toBe(sandboxDocumentPolicy(kind, [hash]))
    // stage 2.8's checks: no referrer meta (Referrer-Policy decides), no inline handlers or styles.
    expect(html).not.toMatch(/name="referrer"|\son[a-z]+=|\sstyle=/i)
  })
})

/** Runs a committed document's script in a fresh realm, as its browser window would. */
async function runDocument(kind: SandboxDocumentKind, fetch: (url: string) => Promise<Response>) {
  const [script] = inlineScripts(await committed(kind))
  const listeners: ((event: unknown) => void)[] = []
  const posted: { message: unknown; targetOrigin: string }[] = []
  const parent = {
    postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin }),
  }
  const attributes = new Map<string, string>()
  const window = {
    location: { href: `${FXM}/sandbox/${SANDBOX_DOCUMENT_FILES[kind].file}` },
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        removeAttribute: (name: string) => attributes.delete(name),
      },
    },
    parent,
    addEventListener: (_type: string, listener: (event: unknown) => void) =>
      listeners.push(listener),
    removeEventListener: () => undefined,
    fetch: vi.fn(fetch),
    setTimeout,
    clearTimeout,
    URL,
    AbortController,
    TextEncoder,
  }
  runInNewContext(script ?? '', window)
  const { port1, port2 } = new MessageChannel()
  for (const listener of listeners) {
    listener({
      data: { type: SANDBOX_MESSAGE.connect, protocol: SANDBOX_PROTOCOL },
      origin: FXM,
      source: parent,
      ports: [port2],
    })
  }
  port1.start()
  const ask = (message: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      port1.addEventListener('message', (event) => resolve(event.data), { once: true })
      port1.postMessage({ type: SANDBOX_MESSAGE.request, ...message })
    })
  return { posted, attributes, fetch: window.fetch, ask, close: () => port1.close() }
}

describe('the generated script', () => {
  it('runs innertube.html in a fresh realm', async () => {
    const document = await runDocument('innertube', async () =>
      Response.json({ responseContext: { visitorData: 'v' } }),
    )
    expect(document.posted).toEqual([
      {
        message: { type: SANDBOX_MESSAGE.hello, protocol: SANDBOX_PROTOCOL, document: 'innertube' },
        targetOrigin: FXM,
      },
    ])
    expect(document.attributes.get(SANDBOX_MARKER_ATTRIBUTE)).toBe('listening')
    const url = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'
    const reply = await document.ask({ id: '1', url, method: 'POST', headers: {}, body: '{}' })
    expect(reply).toMatchObject({ type: SANDBOX_MESSAGE.response, id: '1', status: 200 })
    expect(JSON.parse(new TextDecoder().decode(reply.body as ArrayBuffer))).toEqual({
      responseContext: { visitorData: 'v' },
    })
    const refused = await document.ask({
      id: '2',
      url: 'https://example.com/',
      method: 'POST',
      body: '{}',
    })
    expect(refused).toMatchObject({ type: SANDBOX_MESSAGE.error, id: '2', code: 'forbidden-host' })
    const preflight = await document.ask({
      id: '3',
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(preflight).toMatchObject({ code: 'preflight' })
    expect(document.fetch).toHaveBeenCalledOnce()
    document.close()
  })

  it('runs userhost.html in a fresh realm', async () => {
    const document = await runDocument('userhost', async () => new Response('{"version":61}'))
    expect(document.posted[0]?.message).toMatchObject({ document: 'userhost' })
    const url = 'https://gist.githubusercontent.com/u/1/raw/secret.json'
    expect(await document.ask({ id: 'a', url, method: 'GET' })).toMatchObject({ status: 200 })
    expect(await document.ask({ id: 'b', url, method: 'POST', body: 'x' })).toMatchObject({
      code: 'forbidden-method',
    })
    document.close()
  })
})

describe('compactStrippedSource', () => {
  const compact = (source: string) => compactStrippedSource(source, stripTypes(source))

  it.each([
    ['const x: Foo = 1', 'const x = 1'],
    ['function f(a: string, b?: number): Foo | undefined {}', 'function f(a, b) {}'],
    ['const m = new Map<string, number>()', 'const m = new Map()'],
    ['const v = (a as unknown) as Foo', 'const v = (a)'],
    ['const v = x!.y', 'const v = x.y'],
    ['const s: string = "a: string"', 'const s = "a: string"'],
    ['const f = <T,>(a: T): T => a', 'const f = (a) => a'],
    ['class A {\n  private readonly x = 1\n}', 'class A {\n  x = 1\n}'],
    ['type T = string\nconst a = 1', 'const a = 1'],
    ['/** Doc. */\nexport interface A {\n  /** b */\n  b: string\n}\n\nconst c = 1', 'const c = 1'],
    ["import type { X } from './x'\n\nconst a = 1", 'const a = 1'],
    [
      "/** Module. */\n\nimport type { X } from './x'\nconst a = 1",
      '/** Module. */\n\nconst a = 1',
    ],
    [
      'export const P: Readonly<\n  Record<string, number>\n> = Object.freeze({})',
      'export const P = Object.freeze({})',
    ],
    ['const o = { a: 1 } satisfies Record<string, number>\nlet b', 'const o = { a: 1 }\nlet b'],
    [
      'function g(\n  a: {\n    x: string\n  },\n  b: number,\n) {}',
      'function g(\n  a,\n  b,\n) {}',
    ],
  ])('%j', (source, expected) => {
    expect(compact(source)).toBe(expected)
  })

  it('needs the stripped text to keep every character in place', () => {
    expect(() => compactStrippedSource('const a: A = 1', 'const a = 1')).toThrow(/in place/)
  })
})

describe('toDocumentScript', () => {
  it('drops `export` from declarations', () => {
    expect(
      toDocumentScript('export const a = 1\nexport function f() {}\nexport async function g() {}'),
    ).toBe('const a = 1\nfunction f() {}\nasync function g() {}')
  })

  it.each([
    ["import { x } from './x'\nconst a = x", /must stand alone.*import/],
    ["export { a } from './a'", /must stand alone.*export/],
    ['const a = 1\nexport default a', /must stand alone.*export default/],
    ["const s = '</script>'", /would end the script/],
    ["const s = '<!--'", /would end the script/],
  ])('refuses %j', (source, message) => {
    expect(() => toDocumentScript(source)).toThrow(message)
  })
})
