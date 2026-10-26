import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MANIFEST_NAME, releaseFiles, TARGETS } from '../release/targets.ts'

// Checks the desktop app's release workflow (.github/workflows/desktop-release.yml), how
// release.yml and desktop.yml call it, and R.1's release catalog against release/targets.ts. The
// workflows are read as text, so these checks rely on their layout: two-space indentation, one
// item per line, as in workflow.test.ts.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const workflow = read('../../../.github/workflows/desktop-release.yml')
const release = read('../../../.github/workflows/release.yml')
const desktop = read('../../../.github/workflows/desktop.yml')
const releaseLib = read('../../../scripts/release-lib.sh')
const toolchainToml = read('../src-tauri/rust-toolchain.toml')
const releaseConfig = JSON.parse(read('../src-tauri/tauri.release.conf.json')) as Record<
  string,
  unknown
>

/** A GitHub Actions expression as the workflows spell it, `${{ … }}`. */
const expression = (inner: string) => `\${{ ${inner} }}`

/** The strings in a TOML array. */
const tomlStrings = (array = '') => [...array.matchAll(/"([^"]*)"/g)].map(([, value]) => value)

/** A job of a workflow, from its id to the next job, as text. */
function job(source: string, id: string): string {
  const start = source.indexOf(`\n  ${id}:\n`)
  if (start < 0) throw new Error(`no job ${id}`)
  const rest = source.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

/** The steps of a job, each as text, from one `- ` at step depth to the next. */
function steps(jobText: string): string[] {
  return jobText.split(/\n(?= {6}- )/).slice(1)
}

/** The matrix entries of the build job. */
function matrix() {
  const entries = job(workflow, 'build')
    .split(/\n(?= {10}- name: )/)
    .slice(1)
  return entries.map((entry) => {
    const field = (name: string) =>
      new RegExp(String.raw`^\s+(?:- )?${name}: (.+)$`, 'm').exec(entry)?.[1]
    return {
      target: field('target'),
      os: field('os'),
      triple: field('triple'),
      bundles: field('bundles'),
    }
  })
}

describe('desktop-release.yml', () => {
  it('pins every action to a full commit SHA', () => {
    const actions = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map(([, action]) => action)
    expect(actions).not.toHaveLength(0)
    for (const action of actions) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
  })

  it('builds exactly the targets of release/targets.ts, on runners of their own CPU or cross-compiled', () => {
    expect(matrix().map(({ target, triple, bundles }) => ({ target, triple, bundles }))).toEqual(
      TARGETS.map(({ id, triple, bundles }) => ({ target: id, triple, bundles })),
    )
    expect(matrix().map(({ os }) => os)).toEqual([
      'macos-latest',
      'macos-latest',
      'windows-latest',
      'ubuntu-22.04',
      'ubuntu-22.04-arm',
    ])
  })

  it('installs the Rust release and components of rust-toolchain.toml on Windows, with its target', () => {
    const channel = /^channel = "([^"]+)"$/m.exec(toolchainToml)?.[1]
    const components = tomlStrings(/^components = \[([^\]]*)\]$/m.exec(toolchainToml)?.[1])
    const toolchains = [...workflow.matchAll(/^\s+toolchain: (\S+)$/gm)].map(([, value]) => value)
    expect(toolchains).toEqual([channel])
    expect(/^\s+components: (.+)$/m.exec(workflow)?.[1]?.split(/[\s,]+/)).toEqual(components)
    expect(/^\s+targets: (.+)$/m.exec(workflow)?.[1]).toBe('x86_64-pc-windows-msvc')
  })

  it('builds with tauri-action, which creates no release and uploads nothing', () => {
    const build = steps(job(workflow, 'build')).find((step) =>
      step.includes('tauri-apps/tauri-action@'),
    )
    expect(build).toBeDefined()
    for (const input of [
      'tagName',
      'releaseId',
      'releaseName',
      'releaseDraft',
      'uploadWorkflowArtifacts',
    ]) {
      expect(build).not.toMatch(new RegExp(String.raw`^\s+${input}:`, 'm'))
    }
    expect(build).toContain('--config src-tauri/tauri.release.conf.json')
    expect(build).toContain('-- --locked')
    // The throwaway key of the step before, never the updater key.
    expect(build).toMatch(/TAURI_SIGNING_PRIVATE_KEY: \$\{\{ steps\.build-key\.outputs\.key \}\}/)
  })

  it('hands the updater key to the signing step alone, in a job that installs nothing', () => {
    const occurrences = workflow.match(/secrets\.TAURI_SIGNING_PRIVATE_KEY\b/g) ?? []
    expect(occurrences).toHaveLength(1)
    const sign = job(workflow, 'sign')
    const signing = steps(sign).filter((step) => step.includes('secrets.'))
    expect(signing).toHaveLength(1)
    expect(signing[0]).toMatch(/release\.ts sign /)
    expect(signing[0]).toMatch(/if: inputs\.release\n/)
    // Only GitHub's own actions, and no package manager or toolchain: the key meets no
    // third-party code.
    const actions = [...sign.matchAll(/uses: ([\w-]+\/[\w-]+)@/g)].map(([, action]) => action)
    expect(new Set(actions)).toEqual(
      new Set([
        'actions/checkout',
        'actions/setup-node',
        'actions/download-artifact',
        'actions/upload-artifact',
      ]),
    )
    expect(sign).not.toMatch(/\b(pnpm|npm|npx|make|cargo|apt-get)\b/)
  })

  it('signs a release in the updater key’s environment, and a dry run with a throwaway key', () => {
    const sign = job(workflow, 'sign')
    expect(sign).toContain(
      `environment: ${expression("inputs.release && 'desktop-updater' || ''")}`,
    )
    const dryRun = steps(sign).find((step) => step.includes('--throwaway-key'))
    expect(dryRun).toMatch(/if: \$\{\{ !inputs\.release \}\}/)
  })

  it('stops a release while the updater key is the placeholder, before anything builds', () => {
    expect(job(workflow, 'check')).toMatch(/release\.ts check --mode "\$MODE"/)
    expect(job(workflow, 'check')).toContain(
      `MODE: ${expression("inputs.release && 'release' || 'dry-run'")}`,
    )
    expect(job(workflow, 'build')).toMatch(/^ {4}needs: check$/m)
  })

  it('uploads release-desktop, the artifact release.yml publishes', () => {
    expect(job(workflow, 'sign')).toMatch(/name: release-desktop\n\s+path: dist\/release-desktop\//)
  })

  it('builds without caches, as release.yml does', () => {
    expect(workflow).not.toContain('actions/cache@')
  })

  it('checks the macOS signature is ad hoc and the .deb asks for GStreamer', () => {
    expect(workflow).toMatch(/grep -qx 'Signature=adhoc'/)
    expect(workflow).toContain(
      'for package in gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-libav',
    )
    expect(workflow).toContain('apps/desktop/release/gstreamer-check.sh')
  })
})

describe('tauri.release.conf.json', () => {
  it('turns on the updater’s files, and changes nothing else', () => {
    expect(releaseConfig).toEqual({
      $schema: 'https://schema.tauri.app/config/2',
      bundle: { createUpdaterArtifacts: true },
    })
  })
})

describe('release.yml', () => {
  const desktopJob = job(release, 'desktop')

  it('builds the desktop app for every release, with the updater key', () => {
    expect(desktopJob).toContain('uses: ./.github/workflows/desktop-release.yml')
    expect(desktopJob).toContain("if: needs.plan.outputs.release == 'true'")
    expect(desktopJob).toMatch(/sha: \$\{\{ needs\.plan\.outputs\.sha \}\}/)
    expect(desktopJob).toMatch(/version: \$\{\{ needs\.plan\.outputs\.version \}\}/)
    expect(desktopJob).toMatch(/release: true/)
    const secrets = [...desktopJob.matchAll(/^ {6}(\w+): \$\{\{ secrets\.(\w+) \}\}$/gm)]
    expect(secrets.map(([, name, secret]) => [name, secret])).toEqual([
      ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY'],
      ['TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'],
    ])
  })

  it('publishes only once the desktop job succeeded, with its files', () => {
    const publish = job(release, 'publish')
    expect(publish).toMatch(/needs: \[plan, bundles, firefox, desktop\]/)
    expect(publish).toMatch(/name: release-desktop\n\s+path: dist\/artifacts\/release-desktop/)
  })
})

describe('desktop.yml', () => {
  it('runs a dry run of the release when started by hand with release-dry-run', () => {
    expect(desktop).toMatch(/workflow_dispatch:\n {4}inputs:\n {6}release-dry-run:\n/)
    const dryRun = job(desktop, 'release-dry-run')
    expect(dryRun).toContain('uses: ./.github/workflows/desktop-release.yml')
    expect(dryRun).toContain(`if: ${expression('inputs.release-dry-run')}`)
    // No key, no release.
    expect(dryRun).not.toMatch(/secrets|release: true/)
    expect(job(desktop, 'build')).toContain(`if: ${expression('!inputs.release-dry-run')}`)
  })
})

describe('the release catalog (scripts/release-lib.sh)', () => {
  it('lists for release-desktop exactly the files release/targets.ts makes, and latest.json', () => {
    const listed = [...releaseLib.matchAll(/^release-desktop\|([^|]+)\|/gm)].map(([, name]) => name)
    expect([...listed].sort()).toEqual(
      [...releaseFiles('<version>').map((file) => file.name), MANIFEST_NAME].sort(),
    )
  })
})
