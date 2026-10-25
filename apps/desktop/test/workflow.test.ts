import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Checks .github/workflows/desktop.yml against the rest of the repo. The workflow is read as
// text, so these checks rely on its layout: two-space indentation, one item per line.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const workflow = read('../../../.github/workflows/desktop.yml')

/** The `paths` filter of one of the workflow's triggers, such as `push`. */
function triggerPaths(trigger: string) {
  const list = new RegExp(String.raw`^  ${trigger}:\n    paths:\n((?: {6}- .+\n)+)`, 'm').exec(
    workflow,
  )?.[1]
  return [...(list ?? '').matchAll(/- (.+)/g)].map(([, path]) => path)
}

describe('desktop.yml', () => {
  it('pins every action to a full commit SHA', () => {
    const actions = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map(([, action]) => action)
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
        'Makefile',
        'package.json',
        'pnpm-lock.yaml',
        '.github/workflows/desktop.yml',
      ]),
    )
  })
})
