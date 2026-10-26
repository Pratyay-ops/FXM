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
 *   `@bufbuild/protobuf`, which keeps Google's BSD-3-Clause notice, or every notice of a package
 *   that ships no licence file at all.
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
  /** Its text, trimmed. */
  readonly text: string
}

/** The licence, copying and notice files in a package's folder, sorted by name. */
export function licenceFiles(dir: string): LicenceFile[] {
  return readdirSync(dir)
    .filter(isLicenceFileName)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8').trim() }))
}

/** A line before a file's first comment that holds no code of its own worth a notice. */
const PREAMBLE =
  /^\s*(?:#!.*|(['"])use strict\1;?|import\s[^;]*?from\s*(['"]).*?\2;?|import\s*(['"]).*?\3;?)?\s*$/

/**
 * The comment a file opens with, without its comment marks: a run of `//` lines, or one block
 * comment (`/* … *\/`, `/** … *\/`, `/*! … *\/`), or `''`. It may follow a hashbang, `'use strict'`, blank
 * lines and one-line imports, which bundlers such as Rollup put above a file's licence header.
 */
export function leadingComment(code: string): string {
  const lines = code.replace(/^﻿/, '').split('\n')
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

/** A line that states a copyright: `Copyright 2008 Google Inc.`, `(c) 2020 …`, `© …`. */
const COPYRIGHT_LINE = /^\s*(?:copyright\b|\(c\)|©)/i

/** Words that grant or name a licence, or point at one. */
const LICENCE_GRANT =
  /SPDX-License-Identifier|@license\b|licen[cs]ed under|permission is hereby granted|permission to use, copy|redistribution and use|governed by an? [\w-]+ licen[cs]e|licen[cs]e that can be found/i

/** Whether a comment states a copyright or grants a licence. */
export function isNotice(comment: string): boolean {
  return (
    comment.split('\n').some((line) => COPYRIGHT_LINE.test(line)) || LICENCE_GRANT.test(comment)
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

/**
 * Who a comment's copyright lines name, normalized: `Copyright (c) 2017 - Present Tauri Apps
 * Contributors` names `tauri apps contributors`.
 */
export function copyrightHolders(comment: string): string[] {
  return comment
    .split('\n')
    .filter((line) => COPYRIGHT_LINE.test(line))
    .map((line) =>
      normalized(line.replace(/copyright|\(c\)|©|all rights reserved/gi, ' ').replace(YEARS, ' ')),
    )
    .filter((holder) => holder !== '')
}

/**
 * Whether a notice from a package's file adds to its licence texts: it does unless the texts
 * contain all of it, or name every holder of its copyright lines. A notice without a copyright
 * line, such as `SPDX-License-Identifier: MIT`, adds nothing to a licence file; for a package
 * without one, every notice counts.
 */
export function addsToLicence(notice: string, licenceTexts: readonly string[]): boolean {
  if (licenceTexts.length === 0) return true
  // Padded, so that only whole words match: a holder "meta" is not in "metadata".
  const licence = ` ${normalized(licenceTexts.join('\n'))} `
  if (licence.includes(` ${normalized(notice)} `)) return false
  return copyrightHolders(notice).some((holder) => !licence.includes(` ${holder} `))
}

/** Files whose opening comment can be read as text. */
const TEXT_FILE = /^\.(?:[cm]?[jt]sx?|css)$/i

/**
 * The notices that a package's bundled files open with and that add to its licence texts
 * ({@link addsToLicence}), each once, in file order. Notices that differ only in their years count
 * as one, and so does a notice that runs on into a comment about the code (a file whose licence
 * header is followed by more `//` lines): the shorter one stays.
 */
export function fileNotices(files: Iterable<string>, licenceTexts: readonly string[]): string[] {
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
    if (!comment || !isNotice(comment) || !addsToLicence(comment, licenceTexts)) continue
    const key = normalized(comment.replace(YEARS, ' '))
    if ([...notices.keys()].some((known) => key === known || key.startsWith(`${known} `))) continue
    for (const known of [...notices.keys()]) {
      if (known.startsWith(`${key} `)) notices.delete(known)
    }
    notices.set(key, comment)
  }
  return [...notices.values()]
}

/** A package's licence files and the notices of its bundled files that add to them. */
export interface PackageNotices {
  readonly licenceFiles: readonly LicenceFile[]
  readonly fileNotices: readonly string[]
}

/** The licence files of the package in `dir`, and the notices of its bundled `files` that add to them. */
export function packageNotices(dir: string, files: Iterable<string>): PackageNotices {
  const licences = licenceFiles(dir)
  return {
    licenceFiles: licences,
    fileNotices: fileNotices(
      files,
      licences.map((file) => file.text),
    ),
  }
}
