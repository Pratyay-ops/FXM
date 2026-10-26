import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { EXAMPLE_VERSION } from '../files.ts'
import { NON_FREE_NET_REASON } from '../listing.ts'
import { androidVersionCode, parseVersion, REPO_ROOT } from '../version.ts'
import {
  BUILD_COMMANDS,
  CATEGORIES,
  defaultCommit,
  fdroidRecipe,
  RECIPE_FILE,
  SUBDIR,
  UPDATE_CHECK_DATA,
  UPDATE_CHECK_MODE,
  VERSION_FILE,
  versionFile,
} from './recipe.ts'

const version = parseVersion('0.6.0')
const commit = '0123456789abcdef0123456789abcdef01234567'
const recipe = parse(fdroidRecipe({ version, commit })) as Record<string, unknown>
const build = (recipe.Builds as Record<string, unknown>[])[0] as Record<string, unknown>

/**
 * fdroidserver's field orders (metadata.py, `yaml_app_field_order` and `build_flags`, read
 * 2026-10-26): `fdroid rewritemeta` writes the fields in these orders.
 */
// biome-ignore format: one list, as fdroidserver writes it
const APP_FIELD_ORDER = [
  'Disabled', 'AntiFeatures', 'Categories', 'License', 'AuthorName', 'AuthorEmail',
  'AuthorWebSite', 'WebSite', 'SourceCode', 'IssueTracker', 'Translation', 'Changelog', 'Donate',
  'Liberapay', 'OpenCollective', 'Bitcoin', 'Litecoin', 'Name', 'AutoName', 'Summary',
  'Description', 'RequiresRoot', 'RepoType', 'Repo', 'Binaries', 'Builds',
  'AllowedAPKSigningKeys', 'MaintainerNotes', 'ArchivePolicy', 'AutoUpdateMode',
  'UpdateCheckMode', 'UpdateCheckIgnore', 'VercodeOperation', 'UpdateCheckName',
  'UpdateCheckData', 'CurrentVersion', 'CurrentVersionCode', 'NoSourceSince',
]
// biome-ignore format: one list, as fdroidserver writes it
const BUILD_FIELD_ORDER = [
  'versionName', 'versionCode', 'disable', 'commit', 'timeout', 'subdir', 'submodules', 'sudo',
  'init', 'patch', 'gradle', 'maven', 'output', 'binary', 'srclibs', 'oldsdkloc', 'encoding',
  'forceversion', 'forcevercode', 'rm', 'extlibs', 'prebuild', 'androidupdate', 'target',
  'scanignore', 'scandelete', 'build', 'buildjni', 'ndk', 'preassemble', 'gradleprops',
  'antcommands', 'postbuild', 'novcheck', 'antifeatures',
]

/** Whether `keys` come in the order `order` lists them. */
function inOrder(keys: readonly string[], order: readonly string[]): boolean {
  const positions = keys.map((key) => order.indexOf(key))
  return positions.every(
    (position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1)),
  )
}

describe('the F-Droid recipe', () => {
  it('marks FXM with NonFreeNet, and with no other anti-feature', () => {
    expect(recipe.AntiFeatures).toEqual({ NonFreeNet: { 'en-US': NON_FREE_NET_REASON } })
    expect(build.antifeatures).toBeUndefined()
  })

  it('lists the fields in the order `fdroid rewritemeta` keeps', () => {
    expect(inOrder(Object.keys(recipe), APP_FIELD_ORDER)).toBe(true)
    expect(inOrder(Object.keys(build), BUILD_FIELD_ORDER)).toBe(true)
    expect(recipe.Categories).toEqual([...CATEGORIES])
    expect(recipe.License).toBe('Apache-2.0')
  })

  it('builds the release’s commit with Gradle in the Android app’s module', () => {
    expect(build).toMatchObject({
      versionName: '0.6.0',
      versionCode: androidVersionCode(version),
      commit,
      subdir: SUBDIR,
      gradle: ['yes'],
      build: [...BUILD_COMMANDS],
    })
    expect(existsSync(join(REPO_ROOT, SUBDIR, 'build.gradle'))).toBe(true)
    expect(recipe.CurrentVersion).toBe('0.6.0')
    expect(recipe.CurrentVersionCode).toBe(6000)
    // Without a commit, the tag.
    expect(defaultCommit(version)).toBe('v0.6.0')
  })

  it('runs the build script from the repository’s root, after F-Droid’s scan', () => {
    const [cd, script] = BUILD_COMMANDS
    expect(resolve(REPO_ROOT, SUBDIR, cd.replace(/^cd /, ''))).toBe(resolve(REPO_ROOT))
    expect(() => accessSync(join(REPO_ROOT, script), constants.X_OK)).not.toThrow()
    // Installing dependencies in `prebuild` would put prebuilt binaries in front of the scan.
    expect(build.prebuild).toBeUndefined()
  })

  it('lets F-Droid publish its own signed builds: no upstream binaries or signing keys', () => {
    expect(recipe.Binaries).toBeUndefined()
    expect(recipe.AllowedAPKSigningKeys).toBeUndefined()
  })

  it('finds new releases from their tags and version.txt', () => {
    expect(recipe.AutoUpdateMode).toBe('Version')
    expect(recipe.UpdateCheckMode).toBe(UPDATE_CHECK_MODE)
    const tag = new RegExp(UPDATE_CHECK_MODE.replace(/^Tags /, ''))
    expect(['v0.6.0', 'v12.0.3'].every((name) => tag.test(name))).toBe(true)
    expect(['v0.6.0-beta', '0.6.0', 'desktop-v0.6.0'].some((name) => tag.test(name))).toBe(false)

    const [file, codeRegex, nameFile, nameRegex] = UPDATE_CHECK_DATA.split('|') as [
      string,
      string,
      string,
      string,
    ]
    expect(file).toBe(VERSION_FILE)
    expect(nameFile).toBe('.')
    expect(existsSync(join(REPO_ROOT, file))).toBe(true)
    // What checkupdates reads at a release's tag.
    const text = versionFile(version)
    expect(new RegExp(codeRegex).exec(text)?.[1]).toBe('6000')
    expect(new RegExp(nameRegex).exec(text)?.[1]).toBe('0.6.0')
    // And today's file reads too.
    expect(new RegExp(codeRegex).exec(readFileSync(join(REPO_ROOT, file), 'utf8'))).not.toBeNull()
  })

  it('shows in the README what it prints for an example release', () => {
    const readme = readFileSync(join(REPO_ROOT, 'packaging/fdroid/README.md'), 'utf8')
    const example = fdroidRecipe({
      version: EXAMPLE_VERSION,
      commit: defaultCommit(EXAMPLE_VERSION),
    })
    expect(readme).toContain(`\`\`\`yaml\n${example}\`\`\``)
    expect(readme).toContain(`For a release ${EXAMPLE_VERSION.text}, with its tag`)
  })

  it('tells F-Droid’s maintainers how the build works', () => {
    expect(recipe.MaintainerNotes).toMatch(/packaging\/fdroid\/build\.sh/)
    expect(RECIPE_FILE).toBe('io.github.pratyayops.fxm.yml')
  })

  it('tells them which flag holds downloaded code back, as build.sh sets both', () => {
    // VITE_FXM_DISTRIBUTION is the one the opt-ins read (apps/web/src/lib/distribution.ts): a
    // recipe that set only FXM_DISTRIBUTION would download code and run plugins without asking.
    const notes = String(recipe.MaintainerNotes).replaceAll('\n', ' ')
    expect(notes).toMatch(
      /VITE_FXM_DISTRIBUTION=fdroid makes FXM's signed YouTube code updates and plugins wait for an opt-in/,
    )
    expect(notes).toMatch(/FXM_DISTRIBUTION=fdroid keeps FXM's own update check off/)
    expect(notes).toMatch(/must set both/)
    const script = readFileSync(join(REPO_ROOT, BUILD_COMMANDS[1]), 'utf8')
    expect(script).toContain('FXM_DISTRIBUTION=fdroid VITE_FXM_DISTRIBUTION=fdroid pnpm')
    const gate = readFileSync(join(REPO_ROOT, 'apps/web/src/lib/distribution.ts'), 'utf8')
    expect(gate).toContain('import.meta.env.VITE_FXM_DISTRIBUTION')
  })
})
