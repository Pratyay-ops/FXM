/**
 * What the linker took into the ffmpeg core, the licence each of those files states, and the
 * notices the core must carry for them besides its parts' own licence texts. build.sh runs it
 * right after the link:
 *
 *   node --experimental-strip-types linked-licences.ts <why-extract file> <libs> <emsdk> <out>
 *
 * The linker's `--why-extract` file lists every object it took from an archive. Each object's
 * dependency file names the source and the headers it was compiled from: FFmpeg's `.d` files and
 * Opus's `.deps/*.Plo`. LAME's build keeps none (`--disable-dependency-tracking`), so for its
 * objects the source's local `#include "…"` files are followed instead. Every one of those files
 * is read, and its comments say its licence:
 *
 * - The LGPL (FFmpeg's and LAME's own), no statement or only a copyright line (its part's licence
 *   applies), the zlib and Boost licences (which ask nothing of binaries) and the public domain
 *   need nothing besides the part's licence texts.
 * - The MIT, BSD and ISC licences and the IJG's terms ask for their notice in every copy,
 *   binaries included. `<out>` carries each such file's copyright lines and licence text as its
 *   source states them, grouped by licence text, with the files each applies to: FFmpeg's Ogg
 *   demuxer (MIT), which its FLAC and Matroska demuxers need too, and Opus's files (BSD), some
 *   with copyright holders that Opus's COPYING doesn't name.
 * - The GPL, or a licence statement this script doesn't know, stops the build, unless
 *   {@link REVIEWED} records what a person decided about that very statement.
 *
 * Emscripten's own libraries (its C library, built from musl, compiler-rt's builtins, dlmalloc
 * and its stubs) are credited as a whole by the core's notice; any other archive stops the build.
 *
 * It changes what the core carries, so it is part of the recipe: a change here builds the core
 * again (core-build.ts hashes recipe/).
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What a licence statement is, as far as the core's notice is concerned. */
export type Family =
  | 'LGPL'
  | 'GPL'
  | 'MIT'
  | 'BSD'
  | 'ISC'
  | 'IJG'
  | 'zlib'
  | 'Boost'
  | 'public domain'
  | 'unknown'

/** The families whose notice must come with every copy, binaries included. */
export const NOTICE_FAMILIES: ReadonlySet<Family> = new Set<Family>(['MIT', 'BSD', 'ISC', 'IJG'])

/** How each family's statement reads. The GPL is told from the LGPL in {@link familiesOf}. */
const FAMILY_PATTERNS: readonly (readonly [Family, RegExp])[] = [
  ['LGPL', /GNU (Lesser|Library) General Public Licen[cs]e|\bLGPL\b/i],
  ['MIT', /Permission is hereby granted, free of charge, to any person obtaining a copy/i],
  ['Boost', /Boost Software License/i],
  ['ISC', /Permission to use, copy, modify,? and(\/or)? distribute this software for any purpose/i],
  ['BSD', /Redistribution and use in source and binary forms|\bBSD[- ]licen[cs]ed\b/i],
  ['zlib', /provided ['‘]as-is['’], without any express or implied warranty/i],
  ['IJG', /Independent JPEG Group/i],
  ['public domain', /\bpublic domain\b/i],
]

/** Words that grant or restrict rights: a licence statement with them states some licence. */
const GRANT =
  /\blicen[cs]ed (under|to)\b|\bunder the terms of\b|\bpermission (is )?(hereby )?granted\b|\bare permitted provided\b|\ball rights reserved\b|\bfreely (re)?distributable\b/i

/** Licence texts and full licence names: any comment that holds one states a licence. */
const LICENCE_TEXT =
  /GNU (Lesser |Library )?General Public Licen[cs]e|Permission is hereby granted|Permission to use, copy, modify|Redistribution and use in source and binary forms|Boost Software License|provided ['‘]as-is['’]|Independent JPEG Group/i

/** The LGPL's names, removed before looking for the GPL's. */
const LGPL_NAMES = /GNU (Lesser|Library) General Public Licen[cs]e|\bLGPL(v?[\d.]+)?\b/gi

/** The GPL, once the LGPL's names are gone. */
const GPL = /GNU General Public Licen[cs]e|\bGPL(v?[\d.]+\+?)?\b/

/** The licence families one comment states (none for a comment that states no licence). */
export function familiesOf(comment: string): Family[] {
  // Line by line, as the words read: decoration at line starts goes, and so do line breaks.
  const text = comment.replace(/^[\s*#]+/gm, '').replace(/\s+/g, ' ')
  const families = FAMILY_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([f]) => f)
  if (GPL.test(text.replace(LGPL_NAMES, ''))) families.push('GPL')
  if (families.length === 0 && GRANT.test(text)) families.push('unknown')
  return families
}

/** One comment of a C file, without its markers. */
export interface Comment {
  /** Its lines, without the comment markers and the decoration before each line. */
  readonly text: string
  /** Whether it comes before the file's first line of code. */
  readonly leading: boolean
}

/** The comments of a C source or header, in order. */
export function commentsOf(source: string): Comment[] {
  const comments: Comment[] = []
  let code = false
  // Strings and character literals are skipped, so a `/*` inside one starts no comment.
  const token = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s/"']+|\S/g
  for (const match of source.matchAll(token)) {
    const value = match[0]
    if (value.startsWith('/*') || value.startsWith('//')) {
      comments.push({ text: commentText(value), leading: !code })
    } else {
      code = true
    }
  }
  return comments
}

/** A comment's text: no `/*`, `*\/` or `//`, and no ` * ` or `**` decoration at line starts. */
function commentText(comment: string): string {
  if (comment.startsWith('//')) return comment.replace(/^\/\/+ ?/, '').trimEnd()
  const lines = comment
    .replace(/^\/\*+ ?/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*+ ?/, '').trimEnd())
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift()
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()
  return lines.join('\n')
}

/** A line that opens a copyright notice. */
const COPYRIGHT_LINE = /^\s*(copyrights?\b|\(c\)\s|©)/i

/**
 * Whether a comment is a licence statement, as opposed to the documentation of the code next to
 * it (whose words, such as "may be used", say nothing about rights): a comment before the code,
 * one with a copyright line, or one that holds a licence's text or full name.
 */
export function isStatement(comment: Comment): boolean {
  return (
    comment.leading ||
    comment.text.split('\n').some((line) => COPYRIGHT_LINE.test(line)) ||
    LICENCE_TEXT.test(comment.text.replace(/\s+/g, ' '))
  )
}

/**
 * A notice split into its copyright lines (each with the lines that continue it, indented
 * further) and the rest, the licence text.
 */
export function splitNotice(text: string): { copyrights: string[]; body: string } {
  const copyrights: string[][] = []
  const body: string[] = []
  let open: string[] | undefined
  for (const line of text.split('\n')) {
    if (COPYRIGHT_LINE.test(line)) {
      open = [line.trim()]
      copyrights.push(open)
    } else if (open !== undefined && /^\s{2,}\S/.test(line)) {
      open.push(`  ${line.trim()}`)
    } else {
      open = undefined
      body.push(line)
    }
  }
  while (body.length > 0 && body[0]?.trim() === '') body.shift()
  while (body.length > 0 && body.at(-1)?.trim() === '') body.pop()
  return { copyrights: copyrights.map((lines) => lines.join('\n')), body: body.join('\n') }
}

/** The parts of the core whose files are read. */
export type PartName = 'FFmpeg' | 'LAME' | 'Opus'

/**
 * A licence statement a person read, because this script can't classify it by itself: what the
 * core does about the file. Pinned by the SHA-256 of the file's leading comments
 * ({@link leadingHash}), so a statement that changes in an upgrade is read again.
 */
export interface Reviewed {
  readonly part: PartName
  /** The file's path in its part's source tree. */
  readonly file: string
  readonly leadingSha256: string
  /**
   * `credit`: the file is under its part's licence, and the notices file carries its leading
   * comments, which ask for a credit.
   */
  readonly decision: 'credit'
  readonly why: string
}

export const REVIEWED: readonly Reviewed[] = [
  {
    part: 'LAME',
    file: 'libmp3lame/fft.c',
    leadingSha256: 'd298e5320aaf6d1025838c4a644136777b8f9f14108add1560f7057637050400',
    decision: 'credit',
    why: "Ron Mayer's FFT, part of LAME since 1999 and distributed under LAME's LGPL. His note says it derives from a routine of his that he released under the GPL, and that he would let anyone do whatever they want with it, asking politely for a credit: the notices file carries his note.",
  },
]

/** The SHA-256 of a file's leading comments, as {@link Reviewed} pins them. */
export function leadingHash(source: string): string {
  const leading = commentsOf(source)
    .filter((comment) => comment.leading)
    .map((comment) => comment.text)
  return createHash('sha256').update(leading.join('\n\n')).digest('hex')
}

/** An archive member that the linker took into the core. */
export interface Extracted {
  /** The archive's path, as the linker read it. */
  readonly archive: string
  /** The member's name in the archive: an object file, by its base name. */
  readonly member: string
}

/**
 * The archive members in a `--why-extract` file (one line per member taken: the file that
 * referenced it, then `archive(member)` and the symbol), each once, in order.
 */
export function parseWhyExtract(text: string): Extracted[] {
  const seen = new Set<string>()
  const members: Extracted[] = []
  for (const line of text.split('\n')) {
    const extracted = line.split('\t')[1]
    const match = extracted === undefined ? null : /^(.*)\(([^()/]+)\)$/.exec(extracted)
    if (!match || line.startsWith('reference\t')) continue
    const [, archive = '', member = ''] = match
    const key = `${archive}\0${member}`
    if (seen.has(key)) continue
    seen.add(key)
    members.push({ archive, member })
  }
  return members
}

/** Where a part was built: what libs.sh made of its tarball. */
export interface PartLayout {
  readonly name: PartName
  readonly version: string
  /** Its source tree, built in place. */
  readonly tree: string
  /**
   * Where libs.sh installed its headers, which the other parts include, each with the folder of
   * the tree they come from: a file there is named by its path in the tree.
   */
  readonly installed: Readonly<Record<string, string>>
  /** Its archives, by file name, each with the folder of the tree where its objects are. */
  readonly archives: Readonly<Record<string, string>>
}

/**
 * Emscripten's libraries that the core may link, which its notice credits as a whole: the C
 * library (musl, and Emscripten's own additions), compiler-rt's builtins (Apache-2.0 WITH
 * LLVM-exception, which asks nothing of compiled code), dlmalloc (public domain) and Emscripten's
 * stubs.
 */
export const EMSCRIPTEN_ARCHIVES: ReadonlySet<string> = new Set([
  'libc.a',
  'libclang_rt.builtins.a',
  'libdlmalloc.a',
  'libstubs.a',
])

/** The parts' layouts in libs.sh's folder: their trees are src/<name>-<version>. */
export function partLayouts(libs: string): PartLayout[] {
  const src = join(libs, 'src')
  const tree = (prefix: string): { dir: string; version: string } => {
    const names = existsSync(src)
      ? readdirSync(src).filter((name) => name.startsWith(`${prefix}-`))
      : []
    if (names.length !== 1) {
      throw new Error(`expected one ${prefix}-<version> folder in ${src}, found ${names.length}`)
    }
    const name = names[0] as string
    return { dir: join(src, name), version: name.slice(prefix.length + 1) }
  }
  const ffmpeg = tree('ffmpeg')
  const lame = tree('lame')
  const opus = tree('opus')
  return [
    {
      name: 'FFmpeg',
      version: ffmpeg.version,
      tree: ffmpeg.dir,
      installed: { [join(libs, 'stage', 'usr', 'include')]: '.' },
      archives: {
        'libavformat.a': 'libavformat',
        'libavcodec.a': 'libavcodec',
        'libavutil.a': 'libavutil',
        'libswresample.a': 'libswresample',
      },
    },
    {
      name: 'LAME',
      version: lame.version,
      tree: lame.dir,
      installed: { [join(libs, 'prefix', 'include', 'lame')]: 'include' },
      archives: { 'libmp3lame.a': '.' },
    },
    {
      name: 'Opus',
      version: opus.version,
      tree: opus.dir,
      installed: { [join(libs, 'prefix', 'include', 'opus')]: 'include' },
      archives: { 'libopus.a': '.' },
    },
  ]
}

/** Every file named `name` under `dir`, but not in libtool's `.libs` folders. */
function findFiles(dir: string, name: string): string[] {
  const found: string[] = []
  if (!existsSync(dir)) return found
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '.libs') walk(path)
      } else if (entry.name === name) {
        found.push(path)
      }
    }
  }
  walk(dir)
  return found.sort()
}

/** The prerequisites of the first rule of a Makefile dependency file. */
export function parseDependencyFile(text: string): string[] {
  const joined = text.replace(/\\\r?\n/g, ' ')
  const rule = joined.split(/\r?\n/).find((line) => line.includes(':'))
  if (rule === undefined) return []
  // Only the first `: ` separates the target; Windows-style drive letters never occur here.
  const at = rule.search(/:(\s|$)/)
  return rule
    .slice(at + 1)
    .split(/\s+/)
    .filter(Boolean)
}

/** The source and the headers an object was compiled from, as absolute paths. */
export function sourcesOfObject(object: string, tree: string): string[] {
  const stem = object.replace(/\.o$/, '')
  const candidates = [
    `${stem}.d`,
    join(dirname(object), '.deps', `${basename(stem)}.Plo`),
    join(dirname(object), '.deps', `${basename(stem)}.Po`),
  ]
  const dependencyFile = candidates.find((file) => existsSync(file))
  if (dependencyFile !== undefined) {
    // FFmpeg and Opus build from their tree's top folder, where these paths start.
    return parseDependencyFile(readFileSync(dependencyFile, 'utf8')).map((path) =>
      isAbsolute(path) ? normalize(path) : resolve(tree, path),
    )
  }
  // No dependency file (LAME): the source and its local includes, as LAME's own -I flags find
  // them (the including file's folder, include/, libmp3lame/, the tree).
  const source = `${stem}.c`
  if (!existsSync(source)) throw new Error(`${object} has neither a dependency file nor ${source}`)
  const found = new Set<string>()
  const pending = [source]
  while (pending.length > 0) {
    const file = pending.pop() as string
    if (found.has(file)) continue
    found.add(file)
    for (const [, include = ''] of readFileSync(file, 'utf8').matchAll(
      /^\s*#\s*include\s+"([^"]+)"/gm,
    )) {
      const next = [dirname(file), join(tree, 'include'), join(tree, 'libmp3lame'), tree]
        .map((folder) => resolve(folder, include))
        .find((path) => existsSync(path) && statSync(path).isFile())
      if (next !== undefined) pending.push(next)
    }
  }
  return [...found]
}

/** A notice the core carries: copyright lines and a licence text, and the files they cover. */
export interface Notice {
  readonly part: PartName
  readonly version: string
  /** The files, by path in their part's tree, sorted. */
  readonly files: string[]
  readonly copyrights: string[]
  /** The licence text, or for a credit the file's own words. */
  readonly body: string
  readonly kind: 'licence' | 'credit'
}

/** What {@link auditLinkedFiles} found. */
export interface Audit {
  /** How many objects came from each part, and from Emscripten's libraries. */
  readonly objects: Readonly<Record<PartName | 'Emscripten', number>>
  /** How many of the parts' files were read. */
  readonly files: number
  readonly notices: readonly Notice[]
  /** Why the core may not ship as it is (an empty list when it may). */
  readonly problems: readonly string[]
  /** The parts' own copyright lines, as their sources state them. */
  readonly copyrights: Readonly<Record<PartName, readonly string[]>>
}

/** Whether `path` is `folder` or inside it. */
function inside(path: string, folder: string): boolean {
  const from = relative(folder, path)
  return from === '' || (!from.startsWith('..') && !isAbsolute(from))
}

/**
 * The project-wide copyright lines of FFmpeg and LAME, as their sources state them: FFmpeg's
 * tools print "Copyright (c) <first>-<this> the FFmpeg developers" (fftools), and LAME's README
 * lists its own. Opus's COPYING, which the notice carries in full, opens with its own.
 */
function projectCopyrights(parts: readonly PartLayout[], problems: string[]) {
  const copyrights: Record<PartName, string[]> = { FFmpeg: [], LAME: [], Opus: [] }
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  const ffmpeg = parts.find((part) => part.name === 'FFmpeg')
  if (ffmpeg !== undefined) {
    const first = /program_birth_year\s*=\s*(\d{4})/.exec(
      read(join(ffmpeg.tree, 'fftools', 'ffmpeg.c')),
    )?.[1]
    const last = /^#define CONFIG_THIS_YEAR (\d{4})$/m.exec(
      read(join(ffmpeg.tree, 'config.h')),
    )?.[1]
    if (first === undefined || last === undefined) {
      problems.push(
        "can't read FFmpeg's copyright years (program_birth_year in fftools/ffmpeg.c, CONFIG_THIS_YEAR in config.h)",
      )
    } else {
      copyrights.FFmpeg.push(`Copyright (c) ${first}-${last} the FFmpeg developers`)
    }
  }
  const lame = parts.find((part) => part.name === 'LAME')
  if (lame !== undefined) {
    const lines = read(join(lame.tree, 'README'))
      .split('\n')
      .filter((line) => /^Copyrights? \(c\)/i.test(line))
      .map((line) => line.trim())
    if (lines.length === 0) problems.push("can't find LAME's copyright lines in its README")
    copyrights.LAME.push(...lines)
  }
  return copyrights
}

/**
 * Reads the licence of every file of FFmpeg, LAME and Opus that the members in `extracted` were
 * compiled from. `emsdk` is the Emscripten SDK the core was linked with, whose headers and
 * libraries its notice credits as a whole.
 */
export function auditLinkedFiles(
  extracted: readonly Extracted[],
  parts: readonly PartLayout[],
  emsdk: string,
  reviewed: readonly Reviewed[] = REVIEWED,
): Audit {
  const problems: string[] = []
  const objects: Record<PartName | 'Emscripten', number> = {
    FFmpeg: 0,
    LAME: 0,
    Opus: 0,
    Emscripten: 0,
  }
  /** Every file read, by absolute path, with its part. */
  const files = new Map<string, PartLayout>()
  for (const { archive, member } of extracted) {
    const name = basename(archive)
    const part = parts.find((candidate) => Object.hasOwn(candidate.archives, name))
    if (part === undefined) {
      if (EMSCRIPTEN_ARCHIVES.has(name) && inside(archive, emsdk)) objects.Emscripten++
      else {
        problems.push(
          `the core links ${member} from ${archive}, which is neither FFmpeg's, LAME's, Opus's nor one of Emscripten's libraries its notice credits (EMSCRIPTEN_ARCHIVES)`,
        )
      }
      continue
    }
    objects[part.name]++
    const folder = join(part.tree, part.archives[name] as string)
    const found = findFiles(folder, member)
    if (found.length === 0) {
      problems.push(`can't find ${member} of ${name} in ${relative(part.tree, folder) || '.'}`)
      continue
    }
    // Two objects of one archive can share a name (libavcodec's parser.o and opus/parser.o):
    // both are read, as either may be the one taken.
    for (const object of found) {
      let sources: string[]
      try {
        sources = sourcesOfObject(object, part.tree)
      } catch (error) {
        problems.push((error as Error).message)
        continue
      }
      for (const source of sources) {
        if (inside(source, emsdk)) continue
        const owner = parts.find(
          (candidate) =>
            inside(source, candidate.tree) ||
            Object.keys(candidate.installed).some((folder) => inside(source, folder)),
        )
        if (owner === undefined) {
          problems.push(
            `${relative(part.tree, object)} of ${part.name} was compiled from ${source}, which belongs to no part of the core`,
          )
          continue
        }
        files.set(source, owner)
      }
    }
  }

  const groups = new Map<string, Notice>()
  const addNotice = (notice: Omit<Notice, 'files'>, file: string) => {
    const key = `${notice.part}\0${notice.kind}\0${notice.body.replace(/\s+/g, ' ').trim()}`
    const group = groups.get(key) ?? { ...notice, files: [], copyrights: [] }
    if (!group.files.includes(file)) group.files.push(file)
    for (const line of notice.copyrights) {
      if (!group.copyrights.includes(line)) group.copyrights.push(line)
    }
    groups.set(key, group)
  }
  for (const [path, part] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!existsSync(path)) {
      problems.push(`${path}, which ${part.name} was compiled from, is missing`)
      continue
    }
    const source = readFileSync(path, 'utf8')
    // An installed header is named by its path in the tree it was installed from.
    const installed = Object.keys(part.installed).find((folder) => inside(path, folder))
    const file = (
      installed === undefined
        ? relative(part.tree, path)
        : join(part.installed[installed] as string, relative(installed, path))
    )
      .split(sep)
      .join('/')
    const comments = commentsOf(source)
    const statements = comments.filter(isStatement)
    const review = reviewed.find((entry) => entry.part === part.name && entry.file === file)
    if (review !== undefined) {
      if (leadingHash(source) !== review.leadingSha256) {
        problems.push(
          `${part.name}'s ${file} no longer says what was reviewed (REVIEWED in linked-licences.ts): read its licence statement again and update the entry`,
        )
        continue
      }
      const leading = comments.filter((comment) => comment.leading).map((c) => c.text)
      const body = leading.join('\n\n')
      addNotice(
        { part: part.name, version: part.version, copyrights: [], body, kind: 'credit' },
        file,
      )
      continue
    }
    const families = new Set(statements.flatMap((comment) => familiesOf(comment.text)))
    if (families.has('GPL')) {
      problems.push(
        `${part.name}'s ${file} states the GPL, which the core may not contain: if it is under the LGPL after all, record that in REVIEWED (linked-licences.ts)`,
      )
      continue
    }
    if (families.has('unknown')) {
      problems.push(
        `${part.name}'s ${file} states a licence linked-licences.ts doesn't know: read it, then teach FAMILY_PATTERNS the licence or record a decision in REVIEWED`,
      )
      continue
    }
    if (![...families].some((family) => NOTICE_FAMILIES.has(family))) continue
    // Its copyright lines come from its leading comments too: Opus's files state them in a
    // comment of their own, before the licence.
    const leadingCopyrights = comments
      .filter((comment) => comment.leading)
      .flatMap((comment) => splitNotice(comment.text).copyrights)
    for (const comment of statements) {
      if (!familiesOf(comment.text).some((family) => NOTICE_FAMILIES.has(family))) continue
      const { copyrights, body } = splitNotice(comment.text)
      addNotice(
        {
          part: part.name,
          version: part.version,
          copyrights: [...new Set([...leadingCopyrights, ...copyrights])],
          body,
          kind: 'licence',
        },
        file,
      )
    }
  }

  // Licences before credits, then by part and by first file: the same order on every build.
  const order: PartName[] = ['FFmpeg', 'LAME', 'Opus']
  const rank = (notice: Notice) =>
    `${notice.kind === 'licence' ? 0 : 1}${order.indexOf(notice.part)}${notice.files[0] ?? ''}`
  const notices = [...groups.values()]
    .map((notice) => ({ ...notice, files: [...notice.files].sort() }))
    .sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0))
  return {
    objects,
    files: files.size,
    notices,
    problems,
    copyrights: projectCopyrights(parts, problems),
  }
}

/** `text` wrapped at `width` columns. */
function wrap(text: string, width = 78, indent = ''): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = `${indent}${word}`
    } else {
      line = line ? `${line} ${word}` : `${indent}${word}`
    }
  }
  if (line) lines.push(line)
  return lines
}

/** The notices file: the parts' copyright lines, then each notice with the files it covers. */
export function renderNotices(audit: Audit, parts: readonly PartLayout[]): string {
  const version = (name: PartName) => parts.find((part) => part.name === name)?.version ?? ''
  const lines = [
    ...wrap(
      "The copyright lines of the core's parts, as their sources state them, then the notices of the files linked into the core that are under a licence of their own which asks that its notice come with every copy, binaries included (the MIT, BSD and ISC licences, the IJG's terms), and the credits files ask for. recipe/linked-licences.ts copied them from the checked sources of every file the linker took into the core; every other file it took is under its part's licence.",
    ),
    '',
  ]
  for (const name of ['FFmpeg', 'LAME'] as const) {
    const copyrights = audit.copyrights[name]
    if (copyrights.length === 0) continue
    lines.push(`${name} ${version(name)}:`, ...copyrights.map((line) => `  ${line}`), '')
  }
  lines.push(`Opus ${version('Opus')}: as its COPYING says.`)
  for (const notice of audit.notices) {
    const one = notice.files.length === 1
    const what =
      notice.kind === 'credit'
        ? `${one ? 'This file asks' : `These ${notice.files.length} files ask`} for this credit`
        : `${one ? 'This file is' : `These ${notice.files.length} files are`} under this licence`
    lines.push(
      '',
      `=== ${notice.part} ${notice.version}`,
      ...wrap(`${what}: ${notice.files.join(', ')}.`),
      '',
    )
    if (notice.copyrights.length > 0) lines.push(...notice.copyrights, '')
    lines.push(notice.body)
  }
  return `${lines.join('\n')}\n`
}

function main(args: readonly string[]): number {
  const [whyExtract, libs, emsdk, out] = args
  if (!whyExtract || !libs || !emsdk || !out) {
    console.error('usage: linked-licences.ts <why-extract file> <libs folder> <emsdk folder> <out>')
    return 2
  }
  const parts = partLayouts(resolve(libs))
  const audit = auditLinkedFiles(
    parseWhyExtract(readFileSync(whyExtract, 'utf8')),
    parts,
    resolve(emsdk),
  )
  if (audit.problems.length > 0) {
    console.error("The files linked into the ffmpeg core can't ship as they are:")
    for (const problem of audit.problems) console.error(`  - ${problem}`)
    return 1
  }
  writeFileSync(out, renderNotices(audit, parts))
  const { objects } = audit
  console.log(
    `${objects.FFmpeg + objects.LAME + objects.Opus} objects from FFmpeg (${objects.FFmpeg}), LAME (${objects.LAME}) and Opus (${objects.Opus}), and ${objects.Emscripten} from Emscripten's libraries; ${audit.files} source files and headers read, ${audit.notices.reduce((sum, notice) => sum + notice.files.length, 0)} of them with a notice in ${basename(out)}`,
  )
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
