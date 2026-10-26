/**
 * The string inventory: how much hard-coded user-facing text each app and feature folder holds,
 * to size the conversion to messages (docs/I18N.md, "Inventory"). `strings.ts` decides what
 * counts; this walks the apps, groups the findings by area and prints them.
 *
 *   scripts/run.sh pnpm --filter @fxm/i18n inventory              Markdown tables
 *   scripts/run.sh pnpm --filter @fxm/i18n inventory --json       everything, with each finding
 *   scripts/run.sh pnpm --filter @fxm/i18n inventory --list home  the findings of matching areas
 *
 * @module
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Category,
  type Finding,
  scanAndroidStrings,
  scanAstro,
  scanDocument,
  scanJvm,
  scanRust,
  scanScript,
  wordCount,
} from './strings.ts'

/** Where a file's strings are counted: an app and an area in it (a feature folder, a page). */
export interface Area {
  readonly app: 'web' | 'site' | 'extension' | 'desktop' | 'mobile'
  readonly area: string
}

/** Paths that hold no shipped copy: tests, fakes, fixtures, build and dev tooling. */
const EXCLUDED = [
  /(^|\/)node_modules\//,
  /(^|\/)(dist|dist-[\w-]+|build|target|gen|\.gradle)\//,
  /\.(test|spec|e2e)\.\w+$/,
  /(^|\/)(e2e|test|tests|testing|__snapshots__|scripts|smoke|fixtures)\//,
  /(^|\/)(testing|fake-[\w-]+|[\w-]+-fakes|dev-fakes|[\w-]*fixtures?)\.tsx?$/,
  /\.d\.ts$/,
  /(^|\/)[\w.-]+\.config\.\w+$/,
  /^apps\/web\/sandbox\//,
  // The site's build-time checks and their Astro integration: messages for developers.
  /^apps\/site\/src\/(lib\/build-check\.ts|integrations\/)/,
  /^apps\/desktop\/isolation\//,
  /^apps\/extension\/store\/(?!listing\/(description\.md|summary\.txt)$)/,
]

/** Files the scanners read: sources, Android's strings, the installer's text, the store listing. */
const SCANNED =
  /\.(tsx?|mts|astro|html|rs|kt|java)$|\/strings\.xml$|\/tauri\.conf\.json$|^apps\/extension\/store\/listing\//

/** The area a repository path belongs to, or `undefined` when it holds no shipped copy. */
export function areaOf(path: string): Area | undefined {
  if (!SCANNED.test(path) || EXCLUDED.some((pattern) => pattern.test(path))) return undefined
  const feature = /^apps\/web\/src\/(features|components)\/([\w-]+)\//.exec(path)
  if (feature !== null) return { app: 'web', area: `${feature[1]}/${feature[2]}` }
  if (/^apps\/web\/(src\/)?embed\//.test(path)) return { app: 'web', area: 'embed' }
  if (path === 'apps/web/src/main.tsx') return { app: 'web', area: 'app' }
  const folder = /^apps\/web\/src\/([\w-]+)\//.exec(path)
  if (folder !== null) return { app: 'web', area: folder[1] as string }
  if (path === 'apps/web/index.html') return { app: 'web', area: 'index.html' }
  if (/^apps\/web\/pwa\/[\w-]+\.ts$/.test(path)) return { app: 'web', area: 'pwa (manifest)' }
  const site = /^apps\/site\/src\/((pages|components|layouts|lib)\/[\w/.-]+|config\.ts)$/.exec(path)
  if (site !== null)
    return { app: 'site', area: (site[1] as string).replace(/^components\/demos\//, 'components/') }
  if (path.startsWith('apps/extension/src/options/'))
    return { app: 'extension', area: 'options page' }
  if (path === 'apps/extension/src/manifest.ts') return { app: 'extension', area: 'manifest' }
  if (/^apps\/extension\/src\/[\w-]+\.ts$/.test(path))
    return { app: 'extension', area: 'background and bridge' }
  if (path.startsWith('apps/extension/store/listing/'))
    return { app: 'extension', area: 'store listing' }
  if (/^apps\/desktop\/src-tauri\/src\/[\w-]+\.rs$/.test(path))
    return { app: 'desktop', area: 'Rust shell' }
  if (path === 'apps/desktop/src-tauri/tauri.conf.json')
    return { app: 'desktop', area: 'installer text' }
  if (/^apps\/desktop\/bridge\/[\w-]+\.ts$/.test(path)) return { app: 'desktop', area: 'bridge' }
  if (/^apps\/mobile\/android\/.*\/res\/values\/strings\.xml$/.test(path)) {
    return { app: 'mobile', area: 'Android resources' }
  }
  if (/^apps\/mobile\/android\/.*\/src\/main\/.*\.(kt|java)$/.test(path)) {
    return { app: 'mobile', area: 'Kotlin and Java' }
  }
  return undefined
}

/** The findings in one file, by its type. */
export function scanFile(path: string, source: string): Finding[] {
  if (/\.(tsx?|mts|jsx?)$/.test(path)) return scanScript(source, path)
  if (/\.(astro|html)$/.test(path)) return scanAstro(source)
  if (path.endsWith('.rs')) return scanRust(source)
  if (/\.(kt|java)$/.test(path)) return scanJvm(source)
  if (path.endsWith('strings.xml')) return scanAndroidStrings(source)
  if (/^apps\/extension\/store\/listing\/[\w-]+\.(md|txt)$/.test(path)) return scanDocument(source)
  if (path.endsWith('tauri.conf.json')) {
    // What installers show: the descriptions (the product name and title are FXM).
    const config = JSON.parse(source) as { bundle?: Record<string, unknown> }
    return ['shortDescription', 'longDescription'].flatMap((key) => {
      const text = config.bundle?.[key]
      return typeof text === 'string' && text !== ''
        ? [{ category: 'code' as const, text, line: 1 }]
        : []
    })
  }
  return []
}

/** The counts of one area. */
export interface AreaCount extends Area {
  /** Files with at least one finding. */
  files: number
  /** Findings by category. */
  counts: Record<Category, number>
  /** What phase 2 turns into messages: everything but thrown errors. */
  messages: number
  /** Words in those messages. */
  words: number
  findings: (Finding & { readonly file: string })[]
}

const CATEGORIES: readonly Category[] = [
  'text',
  'attribute',
  'code',
  'error',
  'resource',
  'document',
]

/** Every file under `dir`, as repository paths, skipping dependency and output folders. */
function filesUnder(root: string, dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(root, dir))) {
    const path = `${dir}/${name}`
    if (['node_modules', '.git', 'dist', 'target', 'build', '.gradle', '.astro'].includes(name))
      continue
    if (statSync(join(root, path)).isDirectory()) out.push(...filesUnder(root, path))
    else out.push(path)
  }
  return out
}

/** Counts every app's strings under the repository at `root`. */
export function inventory(root: string): AreaCount[] {
  const areas = new Map<string, AreaCount>()
  for (const path of filesUnder(root, 'apps')) {
    const area = areaOf(path)
    if (area === undefined) continue
    const findings = scanFile(path, readFileSync(join(root, path), 'utf8'))
    const key = `${area.app}|${area.area}`
    const entry =
      areas.get(key) ??
      ({
        ...area,
        files: 0,
        counts: Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<
          Category,
          number
        >,
        messages: 0,
        words: 0,
        findings: [],
      } satisfies AreaCount)
    if (findings.length > 0) entry.files += 1
    for (const finding of findings) {
      entry.counts[finding.category] += 1
      if (finding.category !== 'error') {
        entry.messages += 1
        entry.words += wordCount(finding.text)
      }
      entry.findings.push({ ...finding, file: path })
    }
    areas.set(key, entry)
  }
  const apps = ['web', 'site', 'extension', 'desktop', 'mobile']
  return [...areas.values()]
    .filter((entry) => entry.findings.length > 0)
    .sort(
      (a, b) =>
        apps.indexOf(a.app) - apps.indexOf(b.app) ||
        b.messages - a.messages ||
        a.area.localeCompare(b.area),
    )
}

/** The inventory as Markdown: a table per app, then the totals. */
export function markdown(counts: readonly AreaCount[]): string {
  const row = (cells: readonly (string | number)[]) => `| ${cells.join(' | ')} |`
  const header = [
    'Area',
    'Files',
    'Text',
    'Attributes',
    'Code',
    'Errors',
    'Other',
    'Messages',
    'Words',
  ]
  const cells = (name: string, entry: Omit<AreaCount, 'app' | 'area' | 'findings'>) => [
    name,
    entry.files,
    entry.counts.text,
    entry.counts.attribute,
    entry.counts.code,
    entry.counts.error,
    entry.counts.resource + entry.counts.document,
    entry.messages,
    entry.words,
  ]
  const sum = (entries: readonly AreaCount[]) => ({
    files: entries.reduce((total, entry) => total + entry.files, 0),
    counts: Object.fromEntries(
      CATEGORIES.map((category) => [
        category,
        entries.reduce((total, entry) => total + entry.counts[category], 0),
      ]),
    ) as Record<Category, number>,
    messages: entries.reduce((total, entry) => total + entry.messages, 0),
    words: entries.reduce((total, entry) => total + entry.words, 0),
  })
  const lines: string[] = []
  const apps = [...new Set(counts.map((entry) => entry.app))]
  for (const app of apps) {
    const entries = counts.filter((entry) => entry.app === app)
    lines.push(`### ${app}`, '', row(header), row(header.map(() => '---')))
    for (const entry of entries) lines.push(row(cells(`\`${entry.area}\``, entry)))
    lines.push(row(cells('**Total**', sum(entries))), '')
  }
  lines.push('### All apps', '', row(header), row(header.map(() => '---')))
  for (const app of apps)
    lines.push(row(cells(app, sum(counts.filter((entry) => entry.app === app)))))
  lines.push(row(cells('**Total**', sum(counts))), '')
  return lines.join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
  const counts = inventory(root)
  const list = process.argv.indexOf('--list')
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`)
  } else if (list !== -1) {
    const pattern = process.argv[list + 1] ?? ''
    for (const entry of counts.filter((item) => `${item.app}/${item.area}`.includes(pattern))) {
      process.stdout.write(`\n## ${entry.app}: ${entry.area}\n`)
      for (const finding of entry.findings) {
        process.stdout.write(
          `${finding.category.padEnd(9)} ${finding.file}:${finding.line}  ${finding.text}\n`,
        )
      }
    }
  } else {
    process.stdout.write(`${markdown(counts)}\n`)
  }
}
