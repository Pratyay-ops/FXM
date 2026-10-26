/**
 * What phase 2 puts in the web app's first load (docs/I18N.md, "What the first load holds"): the
 * modules `apps/web/src/main.tsx` imports statically, which all load before the app runs; the
 * inventory's messages in them; and the messages that one namespace per feature folder would pull
 * in from the folder's lazy code, since a namespace is one module and a module is in one chunk.
 * Then what each placement adds, compressed as stage 8.5a's budgets count bytes (brotli at
 * quality 4).
 *
 *   scripts/run.sh pnpm --filter @fxm/i18n first-load          a summary
 *   scripts/run.sh pnpm --filter @fxm/i18n first-load --json   everything
 *
 * The walk follows what the bundler follows: static imports and re-exports, but not `import type`
 * or `import()`. On develop at ecaa869 it found the same 158 modules that make dist's bundle
 * inventory lists in the entry chunk and the chunks it imports.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants } from 'node:zlib'
import { parseAst } from 'rolldown/parseAst'
import { type AreaCount, inventory } from './inventory.ts'

/** The module every page of the web app starts from. */
export const MAIN_MODULE = 'apps/web/src/main.tsx'

/** Reads a repository file by its path, or gives `undefined` when there is none. */
export type ReadFile = (path: string) => string | undefined

/** The modules `source` loads when it runs: static imports and re-exports, but not types. */
export function runtimeImports(source: string, file: string): string[] {
  const program = parseAst(source, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }, file)
  const found: string[] = []
  for (const node of program.body) {
    // `import { type A } from './a'` still loads ./a under verbatimModuleSyntax.
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      found.push(node.source.value)
    } else if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      node.source !== null &&
      node.exportKind !== 'type'
    ) {
      found.push(node.source.value)
    }
  }
  return found
}

/**
 * The module a relative `specifier` of `from` names, as the bundler resolves it, or `undefined`
 * for packages, virtual modules and files that aren't TypeScript (styles): none holds app copy.
 */
export function resolveModule(read: ReadFile, from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = posix.join(posix.dirname(from), specifier)
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(
    (path) => /\.tsx?$/.test(path) && read(path) !== undefined,
  )
}

/** The modules of the first load: `entry` and everything it imports statically, sorted. */
export function firstLoadModules(read: ReadFile, entry: string = MAIN_MODULE): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue
    const source = read(file)
    if (source === undefined) throw new Error(`No module ${file}`)
    seen.add(file)
    for (const specifier of runtimeImports(source, file)) {
      const target = resolveModule(read, file, specifier)
      if (target !== undefined) queue.push(target)
    }
  }
  return [...seen].sort()
}

/** A message the inventory found: its feature folder (the area), its file and its text. */
export interface Message {
  readonly area: string
  readonly file: string
  readonly text: string
}

/** Where the web app's messages land in the first load, by how namespaces are drawn. */
export interface Placement {
  /** The modules of the first load. */
  readonly modules: readonly string[]
  /**
   * The messages of first-load modules: all the first load holds when namespaces follow chunk
   * boundaries, so no namespace module is imported by both the first load and lazy code.
   */
  readonly firstLoad: readonly Message[]
  /**
   * The messages of lazy modules in the folders whose first-load modules show text: what one
   * namespace per feature folder adds, since first-load code imports that namespace.
   */
  readonly pulledIn: readonly Message[]
}

/** The web app's messages in `counts` (the inventory): everything but thrown errors. */
export function webMessages(counts: readonly AreaCount[]): Message[] {
  return counts
    .filter((entry) => entry.app === 'web')
    .flatMap((entry) =>
      entry.findings
        .filter((finding) => finding.category !== 'error')
        .map((finding) => ({ area: entry.area, file: finding.file, text: finding.text })),
    )
}

/** Splits the web app's messages in `counts` (the inventory) by the first load's `modules`. */
export function placement(counts: readonly AreaCount[], modules: readonly string[]): Placement {
  const first = new Set(modules)
  const messages = webMessages(counts)
  const firstLoad = messages.filter((message) => first.has(message.file))
  const shared = new Set(firstLoad.map((message) => message.area))
  const pulledIn = messages.filter(
    (message) => shared.has(message.area) && !first.has(message.file),
  )
  return { modules, firstLoad, pulledIn }
}

/** How the bundle names a message: see {@link keyCost}. */
export type Shape =
  /** `t('songCount')`, the key made of the message's first three words (the design). */
  | 'keys'
  /** The same with two words. */
  | 'shortKeys'
  /** Each message an exported constant with its full id, `t(m.songCount)`. */
  | 'ids'
  /** Ids shortened to 5-character hashes by a build step. */
  | 'hashes'
  /** Keys compiled to positions in per-namespace arrays by a build step, `t(3)`. */
  | 'positions'

/** A camelCase key made of the first `words` words of `text`, as a developer might name it. */
export function keyFor(text: string, words: number): string {
  const parts = text
    .normalize('NFD')
    .replace(/\{\}|<\/?>/g, ' ')
    .replace(/[^A-Za-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, words)
    .map((word, index) =>
      index === 0
        ? word.toLowerCase()
        : `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`,
    )
  const key = parts.join('')
  return /^[a-z]/.test(key) ? key : `message${key}`
}

/** The namespace of a folder's messages: `localFiles` for `features/local-files`. */
function namespaceOf(area: string): string {
  return (area.split('/').pop() ?? area).replace(/[^A-Za-z0-9]+(.)/g, (_, next: string) =>
    next.toUpperCase(),
  )
}

/** Short names, as a minifier gives them: `a`, `b`, … `aa`, `ab`, … */
function shortName(index: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let name = ''
  let rest = index
  do {
    name = `${letters[rest % letters.length]}${name}`
    rest = Math.floor(rest / letters.length) - 1
  } while (rest >= 0)
  return name
}

/** A 5-character id from an FNV-1a hash of `text`. */
function hashOf(text: string): string {
  let hash = 0x811c9dc5
  for (const char of text) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193)
  return (hash >>> 0).toString(36).padStart(7, '0').slice(-5)
}

/** Brotli bytes of `text`, as stage 8.5a's budgets count them. */
export function brotliSize(text: string): number {
  const bytes = Buffer.from(text)
  return brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 4,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  }).length
}

/** The keys of `messages`, each unique in its namespace (the area). */
function keysOf(messages: readonly Message[], words: number): Map<Message, string> {
  const keys = new Map<Message, string>()
  const taken = new Set<string>()
  for (const message of messages) {
    const base = keyFor(message.text, words)
    let key = base
    for (let n = 2; taken.has(`${message.area}.${key}`); n += 1) key = `${base}${n}`
    taken.add(`${message.area}.${key}`)
    keys.set(message, key)
  }
  return keys
}

/**
 * What turning the `shown` messages into keyed messages adds to the chunk that holds them, in
 * brotli bytes, against today's inline strings. The text of each `stored` message (default: the
 * shown ones) moves into its namespace's catalog, one per area, in the chunk; each shown
 * message's use site calls the translator with an id instead of holding the text. A namespace per
 * feature folder stores lazy messages too, whose use sites stay in their lazy chunks, so their
 * whole text joins the chunk. Code is modelled as a minifier writes it, compressed on its own.
 */
export function keyCost(
  shown: readonly Message[],
  stored: readonly Message[] = shown,
  shape: Shape = 'keys',
): number {
  // Every shown message needs its catalog entry.
  const catalog = [...new Set([...stored, ...shown])]
  if (catalog.length === 0) return 0
  const keys = keysOf(catalog, shape === 'shortKeys' ? 2 : 3)
  const areas = [...new Set(catalog.map((message) => message.area))]
  const files = [...new Set(shown.map((message) => message.file))]
  const own = (area: string) => catalog.filter((message) => message.area === area)
  const namespaceName = new Map(areas.map((area, index) => [area, shortName(index)]))
  const constantName = new Map(
    catalog.map((message, index) => [message, shortName(areas.length + index)]),
  )
  const position = new Map(
    areas.flatMap((area) => own(area).map((message, index) => [message, index])),
  )
  const literal = (text: string) => JSON.stringify(text)
  const keyOf = (message: Message) => keys.get(message) as string
  const hash = (message: Message) => literal(hashOf(`${message.area}.${keyOf(message)}`))
  const idOf = (message: Message): string =>
    shape === 'ids'
      ? (constantName.get(message) as string)
      : shape === 'hashes'
        ? hash(message)
        : shape === 'positions'
          ? String(position.get(message))
          : literal(keyOf(message))
  const inFile = (file: string) => shown.filter((message) => message.file === file)

  const before = files
    .map(
      (file) =>
        `function(){${inFile(file)
          .map((message) => `x(${literal(message.text)});`)
          .join('')}}`,
    )
    .join('')

  const catalogs = areas
    .map((area) => {
      const name = namespaceName.get(area) as string
      const messages = own(area)
      if (shape === 'ids') {
        return messages
          .map(
            (message) =>
              `const ${constantName.get(message)}=m(${literal(`${namespaceOf(area)}.${keyOf(message)}`)},${literal(message.text)});`,
          )
          .join('')
      }
      if (shape === 'positions') {
        return `const ${name}=d(${literal(namespaceOf(area))},[${messages.map((message) => literal(message.text)).join(',')}]);`
      }
      const entries = messages.map(
        (message) =>
          `${shape === 'hashes' ? hash(message) : keyOf(message)}:${literal(message.text)}`,
      )
      return `const ${name}=d(${literal(namespaceOf(area))},{${entries.join(',')}});`
    })
    .join('')
  const uses = files
    .map((file) => {
      const messages = inFile(file)
      const used = [...new Set(messages.map((message) => message.area))]
      const translators = used
        .map((area, index) => `const t${index}=u(${namespaceName.get(area)});`)
        .join('')
      const calls = messages
        .map((message) => `x(t${used.indexOf(message.area)}(${idOf(message)}));`)
        .join('')
      return `function(){${translators}${calls}}`
    })
    .join('')
  return brotliSize(`${catalogs}${uses}`) - brotliSize(before)
}

/**
 * Brotli bytes of `messages` as a locale's catalog chunk holds them, a JSON object per namespace
 * of key to message, with the English standing in for the translation.
 */
export function catalogSize(messages: readonly Message[]): number {
  const keys = keysOf(messages, 3)
  const catalog: Record<string, Record<string, string>> = {}
  for (const message of messages) {
    const namespace = namespaceOf(message.area)
    catalog[namespace] = { ...catalog[namespace], [keys.get(message) as string]: message.text }
  }
  return brotliSize(`export default ${JSON.stringify(catalog)}`)
}

/** Everything the summary prints. */
export interface FirstLoadReport extends Placement {
  /** Characters of text in {@link Placement.firstLoad} and {@link Placement.pulledIn}. */
  readonly characters: { readonly firstLoad: number; readonly pulledIn: number }
  /** Average length of the descriptive keys of the first load's messages. */
  readonly keyLength: { readonly keys: number; readonly shortKeys: number }
  /** What the first load's messages add, by {@link Shape}, with namespaces along chunks. */
  readonly byShape: Readonly<Record<Shape, number>>
  /** What one namespace per feature folder adds on top, with descriptive keys. */
  readonly perFolder: number
  /** The pulled-in messages by folder, most first. */
  readonly folders: readonly { readonly area: string; readonly messages: number }[]
  /** A locale's catalog chunk ({@link catalogSize}): the first load's part, and the whole app's. */
  readonly catalog: { readonly firstLoad: number; readonly all: number }
}

/** Measures the first load of the repository at `root`. */
export function firstLoadReport(root: string): FirstLoadReport {
  const cache = new Map<string, string | undefined>()
  const read: ReadFile = (path) => {
    if (!cache.has(path)) {
      const full = join(root, path)
      cache.set(path, existsSync(full) ? readFileSync(full, 'utf8') : undefined)
    }
    return cache.get(path)
  }
  const counts = inventory(root)
  const placed = placement(counts, firstLoadModules(read))
  const characters = (messages: readonly Message[]) =>
    messages.reduce((total, message) => total + message.text.length, 0)
  const averageKey = (words: number) => {
    const keys = [...keysOf(placed.firstLoad, words).values()]
    return keys.reduce((total, key) => total + key.length, 0) / Math.max(keys.length, 1)
  }
  const shapes: Shape[] = ['keys', 'shortKeys', 'ids', 'hashes', 'positions']
  const byShape = Object.fromEntries(
    shapes.map((shape) => [shape, keyCost(placed.firstLoad, placed.firstLoad, shape)]),
  ) as Record<Shape, number>
  const folders = new Map<string, number>()
  for (const message of placed.pulledIn) {
    folders.set(message.area, (folders.get(message.area) ?? 0) + 1)
  }
  return {
    ...placed,
    characters: { firstLoad: characters(placed.firstLoad), pulledIn: characters(placed.pulledIn) },
    keyLength: { keys: averageKey(3), shortKeys: averageKey(2) },
    byShape,
    perFolder:
      keyCost(placed.firstLoad, [...placed.firstLoad, ...placed.pulledIn], 'keys') - byShape.keys,
    folders: [...folders]
      .map(([area, messages]) => ({ area, messages }))
      .sort((a, b) => b.messages - a.messages || a.area.localeCompare(b.area)),
    catalog: { firstLoad: catalogSize(placed.firstLoad), all: catalogSize(webMessages(counts)) },
  }
}

/** The report as text. */
export function summary(report: FirstLoadReport): string {
  const n = (value: number) => Math.round(value).toLocaleString('en')
  const row = (label: string, bytes: number) => `  ${label.padEnd(36)} ${n(bytes).padStart(6)} B`
  const withText = new Set(report.firstLoad.map((message) => message.file)).size
  const shown = new Set(report.firstLoad.map((message) => message.area)).size
  return [
    `First load: ${n(report.modules.length)} modules from ${MAIN_MODULE}, ${n(withText)} of them with text in ${n(shown)} folders: ${n(report.firstLoad.length)} messages, ${n(report.characters.firstLoad)} characters.`,
    '',
    'With namespaces along chunk boundaries, the first load holds those messages. Brotli added for their ids:',
    row(`descriptive keys (${report.keyLength.keys.toFixed(1)} characters)`, report.byShape.keys),
    row(
      `two-word keys (${report.keyLength.shortKeys.toFixed(1)} characters)`,
      report.byShape.shortKeys,
    ),
    row('exported constants with full ids', report.byShape.ids),
    row('5-character hashes', report.byShape.hashes),
    row('positions (a build step)', report.byShape.positions),
    '',
    `With one namespace per feature folder, those folders' lazy code adds ${n(report.pulledIn.length)} messages, ${n(report.characters.pulledIn)} characters: ${n(report.perFolder)} B more.`,
    ...report.folders.map(({ area, messages }) => `  ${area.padEnd(24)} ${n(messages)}`),
    '',
    `A locale's catalog, with the English standing in: ${n(report.catalog.all)} B for the whole app, ${n(report.catalog.firstLoad)} B for the first load's namespaces.`,
    '',
  ].join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
  const report = firstLoadReport(root)
  process.stdout.write(
    process.argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : summary(report),
  )
}
