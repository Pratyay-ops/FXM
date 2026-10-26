/**
 * The licence texts and notices of an npm package, shared by `make dist`'s third-party notices
 * (licenses.ts) and the licence banner of the signed YouTube module
 * (packages/sources/src/youtube/module/build.mjs):
 *
 * - its licence files: `LICENSE`, `LICENCE.md`, `LICENSE-MIT`, `LICENSE_APACHE-2.0`, `COPYING`,
 *   `NOTICE`…, but never SPDX metadata such as `LICENSE.spdx`, which names a licence without
 *   giving its text;
 * - the copyright and licence comments its bundled files open with, where they add something the
 *   licence files don't say: code a package took from elsewhere, such as the varint code in
 *   `@bufbuild/protobuf`, which keeps Google's BSD-3-Clause notice, a licence the package's own
 *   doesn't offer, or every notice of a package that ships no licence file at all.
 *
 * Node code with erasable types only: build.mjs imports it through Node's type stripping.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

/** A licence, copying or notice file name, with an optional suffix such as `.md` or `_MIT`. */
const LICENCE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-_.][\w.-]*)?$/i

/** Names that look like licence files but hold metadata or code: `LICENSE.spdx`, `license.js`. */
const NOT_LICENCE_TEXT = /\.(?:spdx|json|[cm]?[jt]sx?)$/i

/** Whether a file in a package's folder holds a licence, copying or notice text. */
export function isLicenceFileName(name: string): boolean {
  return LICENCE_FILE.test(name) && !NOT_LICENCE_TEXT.test(name)
}

/** A licence, copying or notice file of a package. */
export interface LicenceFile {
  readonly name: string
  /** Its text, trimmed, with Unix line endings. */
  readonly text: string
}

/** Text with Unix line endings, without a byte order mark. */
const unixText = (text: string) => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

/** The licence, copying and notice files in a package's folder, sorted by name. */
export function licenceFiles(dir: string): LicenceFile[] {
  return readdirSync(dir)
    .filter(isLicenceFileName)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: unixText(readFileSync(join(dir, name), 'utf8')).trim() }))
}

/** A line before a file's first comment that holds no code of its own worth a notice. */
const PREAMBLE =
  /^\s*(?:#!.*|(['"])use strict\1;?|import\s[^;]*?from\s*(['"]).*?\2;?|import\s*(['"]).*?\3;?)?\s*$/

/**
 * The comment a file opens with, without its comment marks: a run of `//` lines, or one block
 * comment (`/* … *\/`, `/** … *\/`, `/*! … *\/`), or `''`. It may follow a hashbang, `'use strict'`, blank
 * lines and one-line imports, which bundlers such as Rollup put above a file's licence header.
 * Windows line endings read like any others.
 */
export function leadingComment(code: string): string {
  const lines = unixText(code).split('\n')
  let start = 0
  while (start < lines.length && PREAMBLE.test(lines[start] ?? '')) start += 1
  const comment: string[] = []
  for (const line of lines.slice(start)) {
    const match = /^\s*\/\/ ?(.*)$/u.exec(line)
    if (match === null) break
    comment.push(match[1] ?? '')
  }
  if (comment.length > 0) return comment.join('\n').trim()
  const block = /^\s*\/\*!?([\s\S]*?)\*\//u.exec(lines.slice(start).join('\n'))
  return (block?.[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/u, ''))
    .join('\n')
    .trim()
}

/**
 * A copyright mark, anywhere in a line: `Copyright`, `(c)`, `©`, or REUSE's
 * `SPDX-FileCopyrightText`. `Portions Copyright 2008 Google Inc.` names a holder too.
 */
const COPYRIGHT_MARK = /SPDX-FileCopyrightText:?|\bcopyright\b|\(c\)|©/i

/**
 * A line that states a copyright: it starts with a mark (`Copyright 2008 Google Inc.`, `(c) 2020
 * …`, `© …`), or a year follows one (`Portions Copyright 2008 Google Inc.`).
 */
const COPYRIGHT_STATEMENT = new RegExp(
  `^\\s*(?:${COPYRIGHT_MARK.source})|(?:${COPYRIGHT_MARK.source})\\s*(?:(?:\\(c\\)|©)\\s*)?\\d{4}\\b`,
  'i',
)

/** Words that grant or name a licence, or point at one. */
const LICENCE_GRANT =
  /SPDX-License-Identifier|@license\b|licen[cs]ed under|permission is hereby granted|permission to use, copy|redistribution and use|governed by an? [\w-]+ licen[cs]e|licen[cs]e that can be found/i

/** Whether a comment states a copyright or grants a licence. */
export function isNotice(comment: string): boolean {
  return (
    comment.split('\n').some((line) => COPYRIGHT_STATEMENT.test(line)) ||
    LICENCE_GRANT.test(comment)
  )
}

/** Lower case, with every run of other characters than letters and digits as one space. */
function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Years, ranges of years and "present", which differ from file to file of one holder. */
const YEARS = /\b\d{4}\b(?:\s*[-–,]\s*(?:\d{4}\b|present\b))*|\bpresent\b/gi

/** "All rights reserved", which adds nothing to a copyright line. */
const RESERVED = /\ball rights reserved\b/gi

/** Text from a copyright line, normalized, without its marks, years and "All rights reserved". */
function holderText(text: string): string {
  return normalized(
    text
      .replace(new RegExp(COPYRIGHT_MARK.source, 'gi'), ' ')
      .replace(RESERVED, ' ')
      .replace(YEARS, ' '),
  )
}

/**
 * Who a comment's copyright marks name, normalized, from every line with a mark: the words after
 * the mark, or before it when only a year follows (`Foo Bar (c) 2020`). `Copyright (c) 2017 -
 * Present Tauri Apps Contributors` names `tauri apps contributors`, and `Portions Copyright 2008
 * Google Inc.` names `google inc`. A licence text's own lines with a mark ("the above copyright
 * notice and this permission notice…") name words of that licence, which its licence file has.
 */
export function copyrightHolders(comment: string): string[] {
  const holders: string[] = []
  for (const line of comment.split('\n')) {
    const mark = COPYRIGHT_MARK.exec(line)
    if (mark === null) continue
    const holder =
      holderText(line.slice(mark.index + mark[0].length)) || holderText(line.slice(0, mark.index))
    if (holder) holders.push(holder)
  }
  return holders
}

/** The licence ids of an SPDX expression, lower case, without operators and exceptions. */
function expressionIds(expression: string): string[] {
  const ids: string[] = []
  let exception = false
  for (const token of expression.match(/[A-Za-z0-9.+:-]+/g) ?? []) {
    const operator = token.toUpperCase()
    if (exception) exception = false
    else if (operator === 'WITH') exception = true
    else if (operator !== 'AND' && operator !== 'OR') ids.push(token.toLowerCase())
  }
  return ids
}

/** The words of a licence id or name: `Apache-2.0` has `apache`, `2` and `0`. */
const wordsOf = (text: string) => normalized(text).split(' ').filter(Boolean)

/** Words that may come between "licensed under" and the licence's name. */
const LEAD_WORDS: ReadonlySet<string> = new Set(['the', 'terms', 'conditions', 'and', 'of'])

/**
 * Whether the words after "licensed under" and the like only point back at a licence named
 * before: "distributed under the License is distributed…", "under the terms of the License".
 */
function pointsBack(words: readonly string[]): boolean {
  const name = words.find((word) => !LEAD_WORDS.has(word))
  return name === 'license' || name === 'licence'
}

/**
 * The licences a notice names: the ids of its `SPDX-License-Identifier:` lines and of a
 * `@license name vX.Y.Z - <id>` line, and the first words after each "licensed under",
 * "released under" or "distributed under", and of each "governed by a … license", unless they
 * only point back at a licence named before.
 */
function namedLicences(notice: string): { ids: string[]; phrases: string[][] } {
  const ids: string[] = []
  for (const [, expression = ''] of notice.matchAll(/SPDX-License-Identifier:\s*([^\n]+)/gi)) {
    ids.push(...expressionIds(expression))
  }
  for (const [, expression = ''] of notice.matchAll(/@license\b[^\n]*?\s-\s+([^\n]+)/gi)) {
    ids.push(...expressionIds(expression))
  }
  const flat = notice.replace(/\s+/g, ' ')
  const phrases: string[][] = []
  for (const match of flat.matchAll(/\b(?:licen[cs]ed|released|distributed) under /gi)) {
    const end = (match.index ?? 0) + match[0].length
    phrases.push(wordsOf(flat.slice(end, end + 200)).slice(0, 12))
  }
  for (const [, name = ''] of flat.matchAll(/\bgoverned by an? ([\w-]+) licen[cs]e/gi)) {
    phrases.push(wordsOf(name))
  }
  return { ids, phrases: phrases.filter((words) => !pointsBack(words)) }
}

/**
 * Whether a notice names a licence that `licence`, the package's SPDX expression, doesn't offer:
 * an SPDX id it doesn't list (`SPDX-License-Identifier: Apache-2.0` in an MIT package), or a
 * phrase ("licensed under BSD-3-Clause") that holds none of its ids. Without an expression, every
 * licence named counts.
 */
export function namesOtherLicence(notice: string, licence?: string): boolean {
  const offered = licence === undefined ? [] : expressionIds(licence)
  const { ids, phrases } = namedLicences(notice)
  if (ids.some((id) => !offered.includes(id))) return true
  return phrases.some(
    (phrase) => !offered.some((id) => wordsOf(id).every((word) => phrase.includes(word))),
  )
}

/**
 * Whether a notice from a package's file adds to its licence texts: it does unless the texts
 * contain all of it, or name every holder its copyright marks name and it names no licence that
 * `licence`, the package's SPDX expression, doesn't offer ({@link namesOtherLicence}). So
 * `SPDX-License-Identifier: MIT` adds nothing to an MIT package's licence file, and
 * `SPDX-License-Identifier: Apache-2.0` does. For a package without a licence file, every notice
 * counts.
 */
export function addsToLicence(
  notice: string,
  licenceTexts: readonly string[],
  licence?: string,
): boolean {
  if (licenceTexts.length === 0) return true
  // Padded, so that only whole words match: a holder "meta" is not in "metadata".
  const texts = ` ${normalized(licenceTexts.join('\n'))} `
  if (texts.includes(` ${normalized(notice)} `)) return false
  if (copyrightHolders(notice).some((holder) => !texts.includes(` ${holder} `))) return true
  return namesOtherLicence(notice, licence)
}

/** Files whose opening comment can be read as text. */
const TEXT_FILE = /^\.(?:[cm]?[jt]sx?|css)$/i

/** A notice's text for comparing it with others: normalized, without years and "All rights reserved". */
const noticeKey = (comment: string) =>
  normalized(comment.replace(RESERVED, ' ').replace(YEARS, ' '))

/**
 * What `longer` says after the first of its lines that read as the notice `shorterKey`
 * (noticeKey), or undefined when no run of its first lines does: the two differ within a line.
 */
function linesAfter(longer: string, shorterKey: string): string | undefined {
  const lines = longer.split('\n')
  for (let end = 1; end < lines.length; end += 1) {
    if (noticeKey(lines.slice(0, end).join('\n')) === shorterKey) return lines.slice(end).join('\n')
  }
  return undefined
}

/** Words of licences and notices that a comment about code rarely has. */
const LICENCE_WORDS =
  /licen[cs]|copyright|\(c\)|©|warrant|liabilit|permission|permitted|redistribut|SPDX/i

/** Whether text may hold part of a licence or a notice, so that dropping it could lose some. */
const mayHoldLicence = (text: string) => isNotice(text) || LICENCE_WORDS.test(text)

/**
 * Adds a notice to those found so far (keyed by noticeKey) unless they say all it does. Notices
 * that differ only in their years, or in "All rights reserved", count as one. When one notice is
 * another followed by more lines, such as a licence header that runs on into `//` lines about the
 * code, the longer one stays if those lines may hold licence text, and the shorter one if they
 * can't: no part of a licence or notice is ever dropped. Notices that differ within a line both
 * stay.
 */
function addNotice(notices: Map<string, string>, comment: string): void {
  const key = noticeKey(comment)
  for (const [knownKey, known] of [...notices]) {
    if (knownKey === key) return
    const extendsKnown = key.startsWith(`${knownKey} `)
    if (!extendsKnown && !knownKey.startsWith(`${key} `)) continue
    const extra = extendsKnown ? linesAfter(comment, knownKey) : linesAfter(known, key)
    if (extra === undefined) continue
    const longerStays = mayHoldLicence(extra)
    // The notice already found says all that matters: the longer one, or the shorter one when
    // the new one only adds a comment about the code.
    if (extendsKnown ? !longerStays : longerStays) return
    notices.delete(knownKey)
  }
  notices.set(key, comment)
}

/**
 * The notices that a package's bundled files open with and that add to its licence texts
 * ({@link addsToLicence}, with `licence`, its SPDX expression), each once, in file order
 * ({@link addNotice}).
 */
export function fileNotices(
  files: Iterable<string>,
  licenceTexts: readonly string[],
  licence?: string,
): string[] {
  const notices = new Map<string, string>()
  for (const file of [...files].sort()) {
    if (!TEXT_FILE.test(extname(file))) continue
    let code: string
    try {
      code = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const comment = leadingComment(code)
    if (comment && isNotice(comment) && addsToLicence(comment, licenceTexts, licence)) {
      addNotice(notices, comment)
    }
  }
  return [...notices.values()]
}

/**
 * Whether `notices` say `text`, compared without case, punctuation, years and "All rights
 * reserved": `Copyright 2008 Google Inc.` is in `Copyright 2008 Google Inc.  All rights reserved.`
 */
export function noticesSay(notices: readonly string[], text: string): boolean {
  return ` ${noticeKey(notices.join('\n'))} `.includes(` ${noticeKey(text)} `)
}

/** A package's licence files and the notices of its bundled files that add to them. */
export interface PackageNotices {
  readonly licenceFiles: readonly LicenceFile[]
  readonly fileNotices: readonly string[]
}

/**
 * The licence files of the package in `dir`, and the notices of its bundled `files` that add to
 * them. `licence` is the package's SPDX expression, from its package.json.
 */
export function packageNotices(
  dir: string,
  files: Iterable<string>,
  licence?: string,
): PackageNotices {
  const licences = licenceFiles(dir)
  return {
    licenceFiles: licences,
    fileNotices: fileNotices(
      files,
      licences.map((file) => file.text),
      licence,
    ),
  }
}
