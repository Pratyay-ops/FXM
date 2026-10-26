import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { REPO_ROOT } from './version.ts'

interface Step {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly if?: string
  readonly with?: Record<string, unknown>
}

const workflow = parse(readFileSync(join(REPO_ROOT, '.github/workflows/channels.yml'), 'utf8')) as {
  on: Record<string, unknown>
  permissions: unknown
  jobs: { manifests: { if: string; permissions: unknown; steps: Step[] } }
}
const job = workflow.jobs.manifests
const steps = job.steps

/** The step that writes the manifests. */
const WRITE_STEP = 'Write the winget and Flatpak manifests'

/** The identity that signs FXM's release attestations: release.yml, run for main. */
const RELEASE_IDENTITY = 'https://github.com/$REPO/.github/workflows/release.yml@refs/heads/main'

describe('the channels workflow', () => {
  it('runs after Release runs for pushes to this repository’s main, never a fork’s', () => {
    expect(workflow.on.workflow_run).toEqual({
      workflows: ['Release'],
      types: ['completed'],
      branches: ['main'],
    })
    const condition = job.if.replace(/\s+/g, ' ')
    expect(condition).toMatch(/^github\.event_name == 'workflow_dispatch' \|\| \(/)
    expect(condition).toContain("github.event.workflow_run.event == 'push'")
    expect(condition).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    )
    expect(condition).toContain("github.event.workflow_run.head_branch == 'main'")
    // Whatever the run's conclusion: a store job that fails after the release is out fails the
    // run, and the "Find the release" step finds out whether a release came out.
    expect(condition).not.toContain('conclusion')
  })

  it('reads only, and keeps no credentials in the checkout', () => {
    expect(workflow.permissions).toEqual({})
    expect(job.permissions).toEqual({ contents: 'read', attestations: 'read' })
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.['persist-credentials']).toBe(false)
  })

  it('checks the attestation of the release’s SHA256SUMS before it writes any manifest', () => {
    const verify = steps.findIndex((step) => step.run?.includes('gh attestation verify'))
    const write = steps.findIndex((step) => step.name === WRITE_STEP)
    expect(verify).toBeGreaterThan(steps.findIndex((step) => step.name === 'Find the release'))
    expect(verify).toBeLessThan(write)
    const step = steps[verify]
    expect(step?.if).toBe("steps.release.outputs.found == 'true'")
    expect(step?.run).toContain(
      'gh attestation verify dist/channels-input/SHA256SUMS --repo "$REPO"',
    )
    expect(step?.run).toContain(`--cert-identity "${RELEASE_IDENTITY}"`)
    expect(step?.run).toContain('--deny-self-hosted-runners')
    // The identity the release notes ask people to check (scripts/release-publish.sh).
    expect(readFileSync(join(REPO_ROOT, 'scripts/release-publish.sh'), 'utf8')).toContain(
      'identity="https://github.com/$repo/.github/workflows/release.yml@refs/heads/main"',
    )
  })

  it('writes the manifests with the commands the READMEs give, and submits nothing', () => {
    const run = steps.find((step) => step.name === WRITE_STEP)?.run
    expect(run).toContain('packaging/cli.ts')
    expect(run).toContain('channels winget "$VERSION" --sums "$sums" --date "$DATE"')
    expect(run).toContain('channels flatpak "$VERSION" --sums "$sums" --date "$DATE"')
    for (const step of steps) {
      expect(step.run ?? '').not.toMatch(/gh (pr|repo fork)|wingetcreate|git push/)
    }
  })
})
