/**
 * FXM's version as the channels see it: the SemVer `x.y.z` of a release, its Android version
 * code, and the summary that heads its notes (docs/releases/vX.Y.Z.md, docs/WORKFLOW.md
 * "Releases"). Imports only Node's own modules.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A release version, `x.y.z`, as `make release-pr` accepts one. */
export interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** The version as written: `0.6.0`. */
  readonly text: string
}

/** Reads `x.y.z` (digits, no leading zeros). Throws for anything else. */
export function parseVersion(text: string): Version {
  const match = /^(0|[1-9]\d{0,9})\.(0|[1-9]\d{0,9})\.(0|[1-9]\d{0,9})$/.exec(text)
  if (!match) throw new Error(`${JSON.stringify(text)} is not a version x.y.z`)
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number]
  return { major, minor, patch, text }
}

/**
 * The Android version code of a version, as stage 6.6's apps/mobile/android/app/build.gradle
 * makes it (`fxmVersionCode`): major × 1,000,000 + minor × 1,000 + patch, at least 1, so 0.5.0
 * is 5000 and 1.2.3 is 1002003. Minor and patch must stay below 1,000 and major below 2,100
 * (Android's highest code is 2,100,000,000). F-Droid's metadata names each build by it, and
 * F-Droid checks that the APK it builds carries it.
 */
export function androidVersionCode(version: Version): number {
  const { major, minor, patch } = version
  if (major >= 2100 || minor >= 1000 || patch >= 1000) {
    throw new Error(
      `FXM ${version.text} has no Android version code: minor and patch must stay below 1000, major below 2100`,
    )
  }
  return Math.max(1, major * 1_000_000 + minor * 1_000 + patch)
}

/** The tag of a release. */
export function tagOf(version: Version): string {
  return `v${version.text}`
}

/** The page of a release on GitHub. */
export function releasePageUrl(repoUrl: string, version: Version): string {
  return `${repoUrl}/releases/tag/${tagOf(version)}`
}

/** The URL of a file attached to a release. */
export function releaseAssetUrl(repoUrl: string, version: Version, file: string): string {
  return `${repoUrl}/releases/download/${tagOf(version)}/${file}`
}

/** The repository's root, from this folder. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * FXM's version: `version` of the root package.json, which `make release-pr` sets in the release
 * commit (scripts/release-version.sh).
 */
export function productVersion(root: string = REPO_ROOT): Version {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof version !== 'string') throw new Error('the root package.json has no "version"')
  return parseVersion(version)
}

/** Whether `date` is a real calendar day written `YYYY-MM-DD`. */
export function isDay(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const parsed = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date)
}

/**
 * A release's summary (docs/releases/vX.Y.Z.md) as plain paragraphs: Markdown links become their
 * text, emphasis and code marks go, headings and list items become paragraphs of their own.
 * Throws when the summary is missing or still a draft, as `make release-pr` refuses one.
 */
export function releaseSummary(version: Version, root: string = REPO_ROOT): string[] {
  const file = join(root, 'docs', 'releases', `${tagOf(version)}.md`)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(
      `docs/releases/${tagOf(version)}.md is missing: write the release's summary first`,
    )
  }
  if (/^\s*<!--\s*draft:/.test(text)) {
    throw new Error(`docs/releases/${tagOf(version)}.md is still a draft (its first line says so)`)
  }
  return plainParagraphs(text)
}

/** Markdown as plain paragraphs (see {@link releaseSummary}). */
export function plainParagraphs(markdown: string): string[] {
  const paragraphs: string[] = []
  let current: string[] = []
  const flush = () => {
    if (current.length > 0) paragraphs.push(current.join(' '))
    current = []
  }
  for (const raw of markdown.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const line = raw.trim()
    if (line === '') {
      flush()
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    const item = /^(?:[-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (heading || item) {
      flush()
      current.push(inline((heading ?? item)?.[1] ?? ''))
      if (heading) flush()
      continue
    }
    current.push(inline(line))
  }
  flush()
  return paragraphs.filter((paragraph) => paragraph !== '')
}

/** Inline Markdown as text: links, images, emphasis and code marks. */
function inline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .trim()
}

/** Text cut to at most `limit` characters, at the end of a sentence if one ends in time. */
export function fitText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'))
  if (sentence > limit / 2) return cut.slice(0, sentence + 1)
  const space = cut.slice(0, limit - 1).lastIndexOf(' ')
  return `${cut.slice(0, space > 0 ? space : limit - 1).trimEnd()}…`
}
