import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseVersion, REPO_ROOT } from '../version.ts'
import { readVersionFile, VERSION_FILE, versionFile } from './recipe.ts'

let scratch: string | undefined

afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

/**
 * A scratch repository like FXM's, as far as scripts/release-version.sh looks: the root and one
 * workspace package at 0.5.0, APP_VERSION, and this package's CLI with version.txt.
 */
function scratchRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'fxm-release-version-'))
  scratch = root
  for (const file of ['env.sh', 'lib.sh', 'release-lib.sh', 'release-version.sh']) {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    copyFileSync(join(REPO_ROOT, 'scripts', file), join(root, 'scripts', file))
  }
  cpSync(join(REPO_ROOT, 'packaging'), join(root, 'packaging'), {
    recursive: true,
    filter: (source) => !source.includes('node_modules') && !source.endsWith('.test.ts'),
  })
  const json = (name: string) => `{\n  "name": "${name}",\n  "version": "0.5.0"\n}\n`
  writeFileSync(join(root, 'package.json'), json('fxm'))
  writeFileSync(join(root, 'packaging/package.json'), json('@fxm/packaging'))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packaging\n')
  const core = join(root, 'packages/core/src/index.ts')
  mkdirSync(dirname(core), { recursive: true })
  writeFileSync(core, "export const APP_VERSION = '0.5.0'\n")
  writeFileSync(join(root, VERSION_FILE), versionFile(parseVersion('0.5.0')))
  spawnSync('git', ['init', '--quiet'], { cwd: root })
  return root
}

function releaseVersion(root: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(FXM_|PNPM_|pnpm_config_)/.test(name)) env[name] = value
  }
  return spawnSync('bash', ['scripts/release-version.sh', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
}

const versionTxt = (root: string) => readVersionFile(readFileSync(join(root, VERSION_FILE), 'utf8'))

describe('release-version.sh and F-Droid’s version.txt', () => {
  it('sets the version name and code with every other version', () => {
    const root = scratchRepository()
    const set = releaseVersion(root, '0.6.0')
    expect(set.status, set.stderr).toBe(0)
    expect(set.stdout).toMatch(
      /packaging\/fdroid\/version\.txt {2}0\.5\.0 → 0\.6\.0 \(versionCode 6000\)/,
    )
    expect(versionTxt(root)).toEqual({ name: '0.6.0', code: 6000 })
    const check = releaseVersion(root, '--check')
    expect(check.status, check.stderr).toBe(0)
    expect(check.stdout).toMatch(/version\.txt {2}0\.6\.0 \(versionCode 6000\)/)
  })

  it('shows the change in a dry run and writes nothing', () => {
    const root = scratchRepository()
    const dry = releaseVersion(root, '--dry-run', '1.2.3')
    expect(dry.status, dry.stderr).toBe(0)
    expect(dry.stdout).toMatch(/version\.txt {2}0\.5\.0 → 1\.2\.3 \(versionCode 1002003\)/)
    expect(versionTxt(root)).toEqual({ name: '0.5.0', code: 5000 })
  })

  it('fails the check while version.txt names another version', () => {
    const root = scratchRepository()
    writeFileSync(join(root, VERSION_FILE), versionFile(parseVersion('0.4.0')))
    const check = releaseVersion(root, '--check')
    expect(check.status).not.toBe(0)
    expect(check.stderr).toMatch(/must name 0\.5\.0 with versionCode 5000/)
  })
})
