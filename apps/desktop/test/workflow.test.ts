import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Checks .github/workflows/desktop.yml against the rest of the repo. The workflow is read as
// text, so these checks rely on its layout: two-space indentation, one item per line.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const workflow = read('../../../.github/workflows/desktop.yml')
const toolchainToml = read('../src-tauri/rust-toolchain.toml')

/** The strings in a TOML array. */
const tomlStrings = (array = '') => [...array.matchAll(/"([^"]*)"/g)].map(([, value]) => value)

/** The `paths` filter of one of the workflow's triggers, such as `push`. */
function triggerPaths(trigger: string) {
  const list = new RegExp(String.raw`^  ${trigger}:\n    paths:\n((?: {6}- .+\n)+)`, 'm').exec(
    workflow,
  )?.[1]
  return [...(list ?? '').matchAll(/- (.+)/g)].map(([, path]) => path)
}

describe('desktop.yml', () => {
  it('pins every action to a full commit SHA', () => {
    // Reusable workflows of this repository come from the same commit as the caller.
    const actions = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)]
      .map(([, action]) => action)
      .filter((action) => !action?.startsWith('./.github/workflows/'))
    expect(actions).not.toHaveLength(0)
    for (const action of actions) {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    }
  })

  it('runs for the same paths on pushes and pull requests', () => {
    expect(triggerPaths('pull_request')).toEqual(triggerPaths('push'))
  })

  it('runs when the app, the web app it embeds or anything its jobs run changes', () => {
    expect(triggerPaths('push')).toEqual(
      expect.arrayContaining([
        'apps/desktop/**',
        'apps/web/**',
        'packages/**',
        'scripts/**',
        // The licence policy that the crates' check shares with make dist.
        'scripts/build-dist/src/licenses.ts',
        'scripts/build-dist/src/notices.ts',
        'Makefile',
        'package.json',
        'pnpm-lock.yaml',
        '.github/workflows/desktop.yml',
      ]),
    )
  })

  it('turns on engine-strict where it installs without scripts/env.sh', () => {
    // docs/DEVELOPMENT.md, "Node version": env.sh turns it on for make and scripts/run.sh, and
    // pnpm-workspace.yaml leaves it out, where it would fail every Dependabot update.
    expect(read('../../../scripts/env.sh')).toMatch(/^export pnpm_config_engine_strict=true$/m)
    expect(read('../../../pnpm-workspace.yaml')).not.toMatch(/^engineStrict:/m)
    const steps = workflow.slice(workflow.indexOf('\n    steps:\n')).split(/^(?= {6}- )/m)
    const installs = steps.filter((step) => /^\s+(?:run: )?pnpm install\b/m.test(step))
    expect(installs).not.toHaveLength(0)
    for (const step of installs) {
      expect(step).toMatch(/^ {10}pnpm_config_engine_strict: true$/m)
    }
  })

  it('installs the Rust release and components of rust-toolchain.toml on Windows', () => {
    // macOS and Linux install from rust-toolchain.toml itself, through make rust-setup.
    const channel = /^channel = "([^"]+)"$/m.exec(toolchainToml)?.[1]
    const components = tomlStrings(/^components = \[([^\]]*)\]$/m.exec(toolchainToml)?.[1])
    const toolchains = [...workflow.matchAll(/^\s+toolchain: (\S+)$/gm)].map(([, value]) => value)
    expect(channel).toBeDefined()
    expect(toolchains).toEqual([channel])
    expect(/^\s+components: (.+)$/m.exec(workflow)?.[1]?.split(/[\s,]+/)).toEqual(components)
  })
})
