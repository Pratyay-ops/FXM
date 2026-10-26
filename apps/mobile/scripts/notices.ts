/**
 * The Android app's third-party notices (stage 6.6): `assets/public/third-party-notices.txt` in
 * every release APK, which the app shows in Settings → About. The file holds
 *
 * 1. the Android libraries the APK bundles, from Gradle's report (`fxmLibraryReport`,
 *    android/app/libraries.gradle): each library of the release build's runtime classpath that
 *    puts files into the APK, with the licences its Maven POM declares and the licence and NOTICE
 *    files it ships, and each project the APK builds from an npm package (Capacitor's runtime),
 *    with that package's licence files;
 * 2. make dist's notices (scripts/build-dist) for the web app inside the APK, which is built from
 *    the same code as the website's, with the base `/`, and bundles the same packages;
 * 3. the Apache License 2.0, which covers most of the libraries.
 *
 * Like make dist, it refuses what FXM hasn't accepted. A library whose POM declares a licence
 * outside {@link ACCEPTED_LICENCES}, or none that {@link spdxOf} recognizes, needs a human review
 * in {@link REVIEWED_LIBRARIES}. A licence other than the Apache License 2.0 asks for the
 * library's own copyright notice, so such a library must ship a licence file, or its review must
 * give the notice. FXM's own projects may hold no prebuilt JAR or AAR, whose origin the report
 * can't show. `write-notices.ts` runs it for `release-apk.sh build`.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/** The notices file, in the APK's web app folder: the app serves it at `/third-party-notices.txt`. */
export const NOTICES_FILE = 'third-party-notices.txt'

/** Where every release APK holds it. `release-apk.sh` checks each APK for it. */
export const APK_NOTICES_PATH = `assets/public/${NOTICES_FILE}`

/** The file's first line, which `release-apk.sh` looks for in every APK. */
export const NOTICES_TITLE = 'FXM for Android: third-party notices'

/** The first line of make dist's notices (`renderNotices` in scripts/build-dist/src/licenses.ts). */
export const WEB_NOTICES_TITLE = 'FXM third-party notices'

/** FXM's repository, as make dist's notices name it (`REPOSITORY_URL` of scripts/build-dist). */
export const REPOSITORY_URL = 'https://github.com/Pratyay-ops/FXM'

/** The rule between entries, as in make dist's notices. */
const RULE = '='.repeat(78)

/** A licence a POM declares. Either part may be empty. */
export interface PomLicence {
  readonly name: string
  readonly url: string
}

/** A licence or NOTICE file inside a library's AAR or JAR. */
export interface ShippedFile {
  /** Its path in the AAR or JAR, `classes.jar!/…` inside an AAR's JAR. */
  readonly path: string
  readonly text: string
}

/** A library of the release build's runtime classpath, as Gradle reports it. */
export interface ReportedLibrary {
  readonly group: string
  readonly name: string
  readonly version: string
  /** The POM's `<name>`, or `''`. */
  readonly title: string
  /** The POM's `<url>`, or `''`. */
  readonly url: string
  /** What the POM, or the nearest parent POM that names any, declares. */
  readonly licences: readonly PomLicence[]
  /**
   * The files it puts into the APK. A platform (a BOM) and the root of a Kotlin multiplatform
   * library, whose code comes from its `-android` or `-jvm` library, have none.
   */
  readonly files: readonly string[]
  readonly notices: readonly ShippedFile[]
}

/** A project the APK builds from source: FXM's own, or one in an npm package. */
export interface ReportedProject {
  /** Its Gradle path, such as `:capacitor-android`. */
  readonly path: string
  readonly dir: string
}

/** Gradle's report (`fxmLibraryReport`). */
export interface LibraryReport {
  /** The app module's folder. */
  readonly app: string
  readonly libraries: readonly ReportedLibrary[]
  readonly projects: readonly ReportedProject[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function text(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`${where}: ${key} is not a string`)
  return value
}

function list(record: Record<string, unknown>, key: string, where: string): unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) throw new Error(`${where}: ${key} is not a list`)
  return value
}

function recordOf(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where} is not an object`)
  return value
}

/** Reads Gradle's report, and throws when it isn't one. */
export function parseLibraryReport(json: string): LibraryReport {
  const report = recordOf(JSON.parse(json), 'the library report')
  if (report.configuration !== 'releaseRuntimeClasspath') {
    throw new Error('the library report is not of the release build (releaseRuntimeClasspath)')
  }
  const libraries = list(report, 'libraries', 'the library report').map((value, index) => {
    const where = `library ${index + 1}`
    const library = recordOf(value, where)
    return {
      group: text(library, 'group', where),
      name: text(library, 'name', where),
      version: text(library, 'version', where),
      title: text(library, 'title', where),
      url: text(library, 'url', where),
      licences: list(library, 'licences', where).map((licence) => {
        const entry = recordOf(licence, `${where}'s licence`)
        return { name: text(entry, 'name', where), url: text(entry, 'url', where) }
      }),
      files: list(library, 'files', where).map((file) => {
        if (typeof file !== 'string') throw new Error(`${where}: a file name is not a string`)
        return file
      }),
      notices: list(library, 'notices', where).map((notice) => {
        const entry = recordOf(notice, `${where}'s notice`)
        return { path: text(entry, 'path', where), text: text(entry, 'text', where) }
      }),
    }
  })
  const projects = list(report, 'projects', 'the library report').map((value, index) => {
    const where = `project ${index + 1}`
    const project = recordOf(value, where)
    return { path: text(project, 'path', where), dir: text(project, 'dir', where) }
  })
  return { app: text(report, 'app', 'the library report'), libraries, projects }
}

/**
 * The licences the APK may bundle without a review: permissive ones, whose terms these notices
 * meet by giving the licence's text and the library's notices.
 */
export const ACCEPTED_LICENCES: ReadonlySet<string> = new Set([
  'Apache-2.0',
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
])

/** How POMs name those licences, after {@link normalizeLicenceName}. */
const LICENCE_NAMES: readonly (readonly [RegExp, string])[] = [
  [/^(the )?apache( software)?( licen[cs]e)?( version| v)? ?2(\.0)?$/, 'Apache-2.0'],
  [/^asl( version| v)? ?2(\.0)?$/, 'Apache-2.0'],
  [/^(the )?mit( licen[cs]e)?( mit)?$/, 'MIT'],
  [/^(the )?((new|revised|modified) bsd|bsd 3 clause|3 clause bsd)( licen[cs]e)?$/, 'BSD-3-Clause'],
  [/^(the )?((simplified|freebsd) bsd|bsd 2 clause|2 clause bsd)( licen[cs]e)?$/, 'BSD-2-Clause'],
  [/^(the )?isc( licen[cs]e)?$/, 'ISC'],
]

/** Where POMs point for those licences, after {@link normalizeLicenceUrl}. */
const LICENCE_URLS: readonly (readonly [RegExp, string])[] = [
  [/^apache\.org\/licenses\/license-2\.0(\.txt|\.html)?$/, 'Apache-2.0'],
  [/^opensource\.org\/licenses?\/apache-?2(\.0|-0)?(\.php)?$/, 'Apache-2.0'],
  [/^spdx\.org\/licenses\/apache-2\.0(\.html)?$/, 'Apache-2.0'],
  [/^opensource\.org\/licenses?\/mit(-license\.php)?$/, 'MIT'],
  [/^spdx\.org\/licenses\/mit(\.html)?$/, 'MIT'],
  [/^opensource\.org\/licenses?\/bsd-3-clause$/, 'BSD-3-Clause'],
  [/^spdx\.org\/licenses\/bsd-3-clause(\.html)?$/, 'BSD-3-Clause'],
  [/^opensource\.org\/licenses?\/bsd-2-clause$/, 'BSD-2-Clause'],
  [/^spdx\.org\/licenses\/bsd-2-clause(\.html)?$/, 'BSD-2-Clause'],
  [/^opensource\.org\/licenses?\/isc(-license)?(\.txt)?$/, 'ISC'],
]

/** A POM's licence name in lower case, with spaces for punctuation and no trailing full stop. */
export function normalizeLicenceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_,;:()"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
}

/** A licence URL without its scheme, `www.` and trailing slash, in lower case. */
export function normalizeLicenceUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
}

const firstMatch = (table: readonly (readonly [RegExp, string])[], value: string) =>
  value === '' ? undefined : table.find(([pattern]) => pattern.test(value))?.[1]

/**
 * The SPDX id of a licence a POM declares, from its name or its URL, or `undefined` when neither
 * names a licence FXM knows, or they name different ones.
 */
export function spdxOf(licence: PomLicence): string | undefined {
  const byName = firstMatch(LICENCE_NAMES, normalizeLicenceName(licence.name))
  const byUrl = firstMatch(LICENCE_URLS, normalizeLicenceUrl(licence.url))
  if (byName !== undefined && byUrl !== undefined && byName !== byUrl) return undefined
  return byName ?? byUrl
}

/**
 * A human review of a library whose POM declares no licence that {@link spdxOf} recognizes, or one
 * that isn't the Apache License 2.0 while the library ships no licence file.
 */
export interface LibraryReview {
  /** The licence that covers the library, an SPDX id in {@link ACCEPTED_LICENCES}. */
  readonly licence: string
  /**
   * The licence names its POM declared when it was reviewed, `[]` for none. When they change,
   * the notices fail until a human reviews the library again.
   */
  readonly declared: readonly string[]
  /** What the review rests on: where the library states its licence, and when it was read. */
  readonly reason: string
  /** The copyright and licence notice the library states, for a licence but the Apache 2.0. */
  readonly notice?: string
}

/** Reviews by `group:name`. None is needed today: every library's POM names the Apache 2.0. */
export const REVIEWED_LIBRARIES: Readonly<Record<string, LibraryReview>> = {}

/** An npm package whose Android project the APK builds: Capacitor's runtime. */
export interface NpmPackage {
  readonly name: string
  readonly version: string
  readonly license: string | undefined
  readonly homepage: string | undefined
  /** Its licence and NOTICE files, by name. */
  readonly licenceFiles: readonly ShippedFile[]
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([._-].*)?$/i

/** The licence and NOTICE files at the top of a package folder, by name. */
function licenceFilesIn(dir: string): ShippedFile[] {
  return readdirSync(dir)
    .filter((name) => LICENCE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ path: name, text: readFileSync(join(dir, name), 'utf8') }))
}

const NODE_MODULES = `${sep}node_modules${sep}`

/**
 * The npm package a project folder is in, such as `@capacitor/android` for its `capacitor`
 * folder, or `undefined` outside `node_modules`.
 */
export function npmPackageOf(dir: string): NpmPackage | undefined {
  let current = dir
  while (`${current}${sep}`.includes(NODE_MODULES)) {
    const file = join(current, 'package.json')
    if (existsSync(file)) {
      const pkg: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (isRecord(pkg) && typeof pkg.name === 'string' && typeof pkg.version === 'string') {
        return {
          name: pkg.name,
          version: pkg.version,
          license: typeof pkg.license === 'string' ? pkg.license : undefined,
          homepage: typeof pkg.homepage === 'string' ? pkg.homepage : undefined,
          licenceFiles: licenceFilesIn(current),
        }
      }
    }
    current = dirname(current)
  }
  return undefined
}

/** The prebuilt JARs and AARs in one of FXM's own projects, which the report can't attribute. */
function prebuiltIn(dir: string): string[] {
  return ['libs', join('src', 'main', 'libs')].flatMap((folder) => {
    const path = join(dir, folder)
    if (!existsSync(path)) return []
    return readdirSync(path, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(jar|aar)$/i.test(file))
      .map((file) => join(folder, file))
  })
}

/** Whitespace collapsed, for comparing licence texts that differ only in layout. */
const collapse = (value: string) => value.replace(/\s+/g, ' ').trim()

/**
 * Whether a licence file is the Apache License 2.0 itself, with or without its appendix, as
 * AndroidX's AARs ship it: the notices then end with that text once, rather than once a library.
 */
export function isApacheLicenceText(file: string, apacheLicence: string): boolean {
  const whole = collapse(apacheLicence)
  const end = 'END OF TERMS AND CONDITIONS'
  const terms = whole.includes(end) ? whole.slice(0, whole.indexOf(end) + end.length) : whole
  const candidate = collapse(file)
  return candidate === terms || candidate === whole
}

/** What one library's licence turned out to be, or why it can't be shipped. */
type Verdict =
  | { readonly ok: true; readonly licence: string; readonly notices: readonly ShippedFile[] }
  | { readonly ok: false; readonly problem: string }

const coordinates = (library: ReportedLibrary) => `${library.group}:${library.name}`

function judgeLibrary(
  library: ReportedLibrary,
  apacheLicence: string,
  reviewed: Readonly<Record<string, LibraryReview>>,
): Verdict {
  const key = coordinates(library)
  const named = `${key} ${library.version}`
  const declaredIds = library.licences.map(spdxOf)
  const distinct = [...new Set(declaredIds)]
  const fromPom = distinct.length === 1 ? distinct[0] : undefined
  const review = Object.hasOwn(reviewed, key) ? reviewed[key] : undefined
  const declaredNames = library.licences.map((licence) => licence.name || licence.url)
  // What it ships beyond the Apache License's text, which ends the notices anyway.
  const notices = library.notices.filter((file) => !isApacheLicenceText(file.text, apacheLicence))

  let licence: string
  if (review !== undefined) {
    if (JSON.stringify(review.declared) !== JSON.stringify(declaredNames)) {
      return {
        ok: false,
        problem: `${named}: its POM now declares ${describe(declaredNames)}, not ${describe(review.declared)} as when it was reviewed: review it again and update REVIEWED_LIBRARIES (apps/mobile/scripts/notices.ts)`,
      }
    }
    licence = review.licence
  } else if (fromPom === undefined) {
    const why =
      library.licences.length === 0
        ? 'its POM declares no licence'
        : `its POM declares ${describe(declaredNames)}, which FXM doesn't recognize as one licence`
    return {
      ok: false,
      problem: `${named}: ${why}. Read the library's licence, and if FXM may ship it, add a review to REVIEWED_LIBRARIES (apps/mobile/scripts/notices.ts)`,
    }
  } else {
    licence = fromPom
  }
  if (!ACCEPTED_LICENCES.has(licence)) {
    return {
      ok: false,
      problem: `${named} is under ${licence}, which FXM doesn't ship in the APK (ACCEPTED_LICENCES in apps/mobile/scripts/notices.ts)`,
    }
  }
  if (licence !== 'Apache-2.0' && review?.notice === undefined && notices.length === 0) {
    return {
      ok: false,
      problem: `${named} is under ${licence}, whose terms ask for the library's copyright notice, but it ships no licence file: add its notice to a review in REVIEWED_LIBRARIES (apps/mobile/scripts/notices.ts)`,
    }
  }
  const reviewNotice =
    review?.notice === undefined ? [] : [{ path: 'its licence notice', text: review.notice }]
  return { ok: true, licence, notices: [...reviewNotice, ...notices] }
}

const describe = (names: readonly string[]) =>
  names.length === 0 ? 'no licence' : names.map((name) => `"${name}"`).join(' and ')

/** What {@link apkNotices} needs. */
export interface ApkNoticesInput {
  readonly report: LibraryReport
  /** make dist's notices (`dist/pages/third-party-notices.txt`). */
  readonly web: string
  /** The Apache License 2.0: the repository's LICENSE. */
  readonly apacheLicence: string
  /** The repository's folder, which holds FXM's own projects. */
  readonly root: string
  /** Default: {@link REVIEWED_LIBRARIES}. */
  readonly reviewed?: Readonly<Record<string, LibraryReview>>
}

/** The notices, or the problems that keep FXM from shipping the APK's code. */
export interface ApkNotices {
  readonly text: string
  readonly problems: readonly string[]
  /** The libraries and npm packages listed. */
  readonly listed: readonly string[]
}

/** One entry: a rule, a heading, the licence line, the link, and any texts below them. */
function entry(
  heading: string,
  licence: string,
  url: string | undefined,
  files: readonly ShippedFile[],
): string[] {
  const lines = ['', RULE, heading, `Licence: ${licence}`]
  if (url) lines.push(url)
  for (const file of files) {
    if (files.length > 1) lines.push('', `--- ${file.path}`)
    lines.push('', file.text.trim())
  }
  return lines
}

/** The APK's third-party notices (see the module documentation), and what keeps them from it. */
export function apkNotices(input: ApkNoticesInput): ApkNotices {
  const { report, web, apacheLicence, root } = input
  const reviewed = input.reviewed ?? REVIEWED_LIBRARIES
  const problems: string[] = []
  const listed: string[] = []
  const body: string[] = []

  if (web.split('\n', 1)[0]?.trim() !== WEB_NOTICES_TITLE) {
    problems.push(
      `the web notices don't start with "${WEB_NOTICES_TITLE}": pass make dist's dist/pages/${NOTICES_FILE}`,
    )
  }

  // Only what reaches the APK: a BOM or a multiplatform library's root puts no files there.
  const shipped = report.libraries.filter((library) => library.files.length > 0)
  if (shipped.length === 0) problems.push('the library report lists no library with files')
  for (const library of shipped) {
    const verdict = judgeLibrary(library, apacheLicence, reviewed)
    if (!verdict.ok) {
      problems.push(verdict.problem)
      continue
    }
    const title =
      library.title && library.title !== coordinates(library) ? ` (${library.title})` : ''
    const heading = `${coordinates(library)} ${library.version}${title}`
    listed.push(`${coordinates(library)} ${library.version}`)
    body.push(...entry(heading, verdict.licence, library.url, verdict.notices))
  }

  for (const project of [{ path: ':app', dir: report.app }, ...report.projects]) {
    const pkg = npmPackageOf(project.dir)
    if (pkg !== undefined) {
      const named = `${pkg.name} ${pkg.version}`
      if (pkg.license === undefined || !ACCEPTED_LICENCES.has(pkg.license)) {
        problems.push(
          `${named} (the Android project ${project.path}) is under ${pkg.license ?? 'no licence'}, which FXM doesn't ship in the APK`,
        )
      } else if (pkg.licenceFiles.length === 0) {
        problems.push(`${named} (the Android project ${project.path}) ships no licence file`)
      } else {
        listed.push(named)
        body.push(
          ...entry(
            `${named} (built from the Android project in its npm package)`,
            pkg.license,
            pkg.homepage,
            pkg.licenceFiles,
          ),
        )
      }
      continue
    }
    const inside = relative(root, project.dir)
    if (inside === '' || inside.startsWith('..') || inside.startsWith(sep)) {
      problems.push(
        `the Android project ${project.path} (${project.dir}) is neither FXM's own nor in an npm package`,
      )
      continue
    }
    // FXM's own: its source is in the repository, under FXM's licence.
    for (const file of prebuiltIn(project.dir)) {
      problems.push(
        `${inside}${sep}${file} is prebuilt code in the Android project ${project.path}, which the notices can't attribute: build it from source or depend on it from a Maven repository`,
      )
    }
  }

  const lines = [
    NOTICES_TITLE,
    '',
    `FXM is open source under the Apache License 2.0: ${REPOSITORY_URL}`,
    "The Android app is FXM's web app in an Android shell. The shell includes the Android libraries listed first, each under its own licence, and the web app includes the open-source packages that FXM's web notices list after them. The Apache License 2.0, which covers most of them, ends this file.",
    '',
    'The release build writes this file from what the APK contains (apps/mobile/scripts/notices.ts).',
    '',
    RULE,
    'Part 1: Android libraries',
    RULE,
    'The libraries of the Android shell, each with the licence it is under, and the licence and NOTICE files it ships beyond the Apache License 2.0.',
    ...body,
    '',
    RULE,
    'Part 2: the web app',
    RULE,
    "The web app in the APK is built from the same code as FXM's website and bundles the same packages. These are the website's notices, as make dist writes them.",
    '',
    web.trim(),
  ]
  // make dist's notices end with the Apache License 2.0 when one of their packages needs it.
  if (!collapse(web).endsWith(collapse(apacheLicence))) {
    lines.push('', RULE, 'The Apache License 2.0', '', apacheLicence.trim())
  }
  return { text: `${lines.join('\n')}\n`, problems, listed }
}
