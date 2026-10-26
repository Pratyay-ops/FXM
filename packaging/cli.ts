/**
 * `pnpm --filter @fxm/packaging --silent channels <command>`: writes and prints the metadata of
 * FXM's other channels (README.md). Node alone runs it, so the release scripts and workflows need
 * no `pnpm install` for it: `node --experimental-strip-types packaging/cli.ts <command>`.
 *
 *   sync [--check]                         write the generated files: those from listing.ts and
 *                                          the READMEs' examples and links (--check: fail if
 *                                          any is stale)
 *   version <x.y.z> [--dry-run]            set F-Droid's version.txt (scripts/release-version.sh
 *   version --check                        runs these with every other version)
 *   changelog <x.y.z>                      write a release's F-Droid changelog from its summary
 *   fdroid <x.y.z> [--commit <sha>]        print the recipe for fdroiddata
 *   obtainium                              print the Obtainium links
 *   winget <x.y.z> --sums <file> --out <dir> [--date YYYY-MM-DD] [--if-present]
 *                                          write the winget manifests for a release
 *   flatpak <x.y.z> --sums <file> --out <dir> [--date YYYY-MM-DD] [--if-present]
 *                                          write the local Flatpak manifest for a release
 *
 * --if-present: a release without the files a command needs (before stage 7.5's installers)
 * is a notice, not a failure.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DEB_ARCHES, type DebArch, linuxDeb, windowsSetup } from './artifacts.ts'
import { changelogPath, FASTLANE_LIMITS } from './fdroid/fastlane.ts'
import {
  defaultCommit,
  fdroidRecipe,
  RECIPE_FILE,
  readVersionFile,
  VERSION_FILE,
  versionFile,
} from './fdroid/recipe.ts'
import { generatedFiles, pinnedReleaseCertificate, staleFiles } from './files.ts'
import { ICON_SOURCE, metainfoXml } from './flatpak/appdata.ts'
import { flatpakManifest, LOCAL_FILES, SHARED_MODULES } from './flatpak/manifest.ts'
import { FLATPAK_ID } from './listing.ts'
import { addLink, importLink, type ObtainiumOptions, webLink } from './obtainium/obtainium.ts'
import { parseSums } from './sums.ts'
import {
  androidVersionCode,
  fitText,
  isDay,
  parseVersion,
  productVersion,
  REPO_ROOT,
  releaseSummary,
  tagOf,
  type Version,
} from './version.ts'
import { manifestFolder, wingetManifests } from './winget/manifest.ts'

/** Writes a file, with its folders, relative to the repository's root. */
function write(path: string, contents: string | Uint8Array, root = REPO_ROOT): void {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

function fail(message: string): never {
  process.stderr.write(`channels: ${message}\n`)
  process.exit(1)
}

function sync(check: boolean): void {
  if (check) {
    const stale = staleFiles()
    if (stale.length > 0) {
      fail(`these files are stale, run \`channels sync\`:\n  ${stale.join('\n  ')}`)
    }
    process.stdout.write('The generated files are current\n')
    return
  }
  for (const [path, contents] of generatedFiles()) write(path, contents)
  process.stdout.write("Wrote the generated files: the listings and the READMEs' examples\n")
}

/** version.txt's version, or what is wrong with the file. */
function currentVersionFile(): { name: string; code: number } | string {
  const file = join(REPO_ROOT, VERSION_FILE)
  if (!existsSync(file)) return 'missing'
  try {
    return readVersionFile(readFileSync(file, 'utf8'))
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Sets F-Droid's version.txt to `version` (`--dry-run`: shows the change), or checks that it names
 * the root package.json's version (`version` undefined), as scripts/release-version.sh does for
 * every other version.
 */
function setVersion(version: Version | undefined, dryRun: boolean): void {
  const current = currentVersionFile()
  const shown = typeof current === 'string' ? `(${current})` : current.name
  if (version === undefined) {
    const expected = productVersion()
    const code = androidVersionCode(expected)
    if (typeof current === 'string' || current.name !== expected.text || current.code !== code) {
      fail(
        `${VERSION_FILE} must name ${expected.text} with versionCode ${code}, the root package.json's version: run scripts/release-version.sh ${expected.text}`,
      )
    }
    process.stdout.write(`  ${VERSION_FILE}  ${expected.text} (versionCode ${code})\n`)
    return
  }
  const code = androidVersionCode(version)
  const same = typeof current !== 'string' && current.name === version.text && current.code === code
  const detail = same
    ? `${version.text} (unchanged)`
    : `${shown} → ${version.text} (versionCode ${code})`
  process.stdout.write(`  ${VERSION_FILE}  ${detail}\n`)
  if (!dryRun && !same) write(VERSION_FILE, versionFile(version))
}

/** Writes a release's F-Droid changelog ("What's new") from its summary. */
function changelog(version: Version): void {
  const summary = releaseSummary(version)
  const path = changelogPath(version)
  write(path, `${fitText(summary.join('\n\n'), FASTLANE_LIMITS.changelog)}\n`)
  process.stdout.write(`Wrote ${path}: commit it before the release\n`)
}

/** The commit a tag points at, if this checkout has the tag. */
function tagCommit(version: Version): string | undefined {
  const result = spawnSync(
    'git',
    ['rev-parse', '--verify', '--quiet', `${tagOf(version)}^{commit}`],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  const sha = result.stdout?.trim()
  return result.status === 0 && sha !== undefined && /^[\da-f]{40}$/.test(sha) ? sha : undefined
}

function fdroid(version: Version, commit: string | undefined): void {
  const resolved = commit ?? tagCommit(version)
  if (resolved === undefined) {
    process.stderr.write(
      `channels: no tag ${tagOf(version)} here, so the recipe names the tag: run \`git fetch --tags\` for its commit\n`,
    )
  }
  process.stderr.write(`channels: the recipe below goes to fdroiddata's metadata/${RECIPE_FILE}\n`)
  process.stdout.write(fdroidRecipe({ version, commit: resolved ?? defaultCommit(version) }))
}

function obtainium(): void {
  const certificate = pinnedReleaseCertificate()
  const options: ObtainiumOptions = certificate === undefined ? {} : { certificate }
  const add = addLink()
  const app = importLink(options)
  process.stdout.write(
    [
      `Add (Obtainium's Add App screen):   ${add}`,
      `  on the web:                       ${webLink(add)}`,
      `Import FXM's settings:              ${app}`,
      `  on the web:                       ${webLink(app)}`,
      certificate === undefined
        ? 'No release certificate is pinned yet (apps/mobile/release-certificate.txt): the settings pin none.'
        : `The settings pin the release certificate ${certificate}.`,
      '',
    ].join('\n'),
  )
}

/** Reads a release's SHA256SUMS. */
function readSums(file: string | undefined): Map<string, string> {
  if (file === undefined) fail('--sums <SHA256SUMS of the release> is required')
  return parseSums(readFileSync(resolve(file), 'utf8'))
}

/** A release file a command needs that the release doesn't have. */
class MissingFile extends Error {
  readonly file: string
  constructor(file: string) {
    super(`the release has no ${file}`)
    this.file = file
  }
}

/** The checksum of a release file that a command needs. */
function needSum(sums: ReadonlyMap<string, string>, file: string): string {
  const sha = sums.get(file)
  if (sha === undefined) throw new MissingFile(file)
  return sha
}

function winget(version: Version, sums: Map<string, string>, out: string, date?: string): void {
  const installerSha256 = needSum(sums, windowsSetup(version))
  const folder = join(resolve(out), manifestFolder(version))
  const manifests = wingetManifests({
    version,
    installerSha256,
    ...(date === undefined ? {} : { releaseDate: date }),
  })
  for (const [name, contents] of manifests) write(name, contents, folder)
  process.stdout.write(`Wrote the winget manifests of FXM ${version.text} to ${folder}\n`)
}

/** The first paragraph of a release's summary, if it has one that is ready. */
function summaryNote(version: Version): string | undefined {
  try {
    return releaseSummary(version)[0]
  } catch {
    return undefined
  }
}

function flatpak(version: Version, sums: Map<string, string>, out: string, date: string): void {
  const debSha256 = Object.fromEntries(
    DEB_ARCHES.map((arch) => [arch, needSum(sums, linuxDeb(version, arch))]),
  ) as Record<DebArch, string>
  const folder = resolve(out)
  write(`${FLATPAK_ID}.yml`, flatpakManifest({ version, debSha256 }), folder)
  const note = summaryNote(version)
  write(
    LOCAL_FILES.metainfo,
    metainfoXml({ version, date, ...(note === undefined ? {} : { note }) }),
    folder,
  )
  const copies: Record<Exclude<keyof typeof LOCAL_FILES, 'metainfo'>, string> = {
    desktop: `packaging/flatpak/${LOCAL_FILES.desktop}`,
    icon: ICON_SOURCE,
    license: 'LICENSE',
  }
  for (const [key, from] of Object.entries(copies) as [keyof typeof copies, string][]) {
    copyFileSync(join(REPO_ROOT, from), join(folder, LOCAL_FILES[key]))
  }
  process.stdout.write(
    [
      `Wrote the Flatpak manifest of FXM ${version.text} to ${folder}, with its metainfo, desktop entry, icon and licence.`,
      `Before building it, check out ${SHARED_MODULES.url} at ${SHARED_MODULES.commit} into ${join(folder, SHARED_MODULES.folder)} (packaging/flatpak/README.md).`,
      '',
    ].join('\n'),
  )
}

/** Today in UTC, `YYYY-MM-DD`. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function main(argv: readonly string[]): void {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      check: { type: 'boolean', default: false },
      commit: { type: 'string' },
      date: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'if-present': { type: 'boolean', default: false },
      out: { type: 'string' },
      sums: { type: 'string' },
    },
  })
  const [command, versionText] = positionals
  const version = () => {
    if (versionText === undefined) fail(`${command} needs a version x.y.z`)
    try {
      return parseVersion(versionText)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }
  const out = () => values.out ?? fail('--out <folder> is required')
  const date = () => {
    if (values.date !== undefined && !isDay(values.date)) fail(`${values.date} is not a day`)
    return values.date
  }
  const commands: Readonly<Record<string, () => void>> = {
    sync: () => sync(values.check),
    version: () => setVersion(values.check ? undefined : version(), values['dry-run']),
    changelog: () => changelog(version()),
    fdroid: () => fdroid(version(), values.commit),
    obtainium: () => obtainium(),
    winget: () => winget(version(), readSums(values.sums), out(), date()),
    flatpak: () => flatpak(version(), readSums(values.sums), out(), date() ?? today()),
  }
  const run = command === undefined ? undefined : commands[command]
  if (run === undefined) {
    fail(`usage: channels ${Object.keys(commands).join('|')} (see packaging/cli.ts)`)
  }
  try {
    run()
  } catch (error) {
    if (error instanceof MissingFile && values['if-present']) {
      process.stdout.write(`Skipped ${command}: ${error.message}\n`)
      return
    }
    fail(error instanceof Error ? error.message : String(error))
  }
}

main(process.argv.slice(2))
