/**
 * Offline tests of scripts/build-dist-wrangler/deploy.sh: a copy of it runs in a temporary
 * checkout whose wrangler and curl are stand-ins. They log their calls and answer from a state
 * file, so nothing reaches Cloudflare and no token is involved.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ROOT } from './paths.ts'
import { removeTempDirs, tempDir, writeFiles } from './testing.ts'

afterEach(removeTempDirs)

/** What the stand-ins answer. */
interface StubState {
  /** Projects in the account; listOutput replaces the whole listing when set. */
  projects?: readonly string[]
  listOutput?: string
  listFails?: boolean
  createFails?: boolean
  /** production_branch in the project's details; detailsFail makes the API call fail. */
  productionBranch?: string
  detailsFail?: boolean
  /** What the deployment reports, per Pages branch. */
  environment?: Record<string, string>
  alias?: Record<string, string>
}

const WRANGLER_STUB = `#!/usr/bin/env node
const fs = require('fs')
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, 'utf8'))
const args = process.argv.slice(2)
fs.appendFileSync(process.env.STUB_LOG, 'wrangler ' + args.join(' ') + '\\n')
const command = args.slice(0, 3).join(' ')
if (command === 'pages project list') {
  if (state.listFails) process.exit(1)
  if (state.listOutput !== undefined) process.stdout.write(state.listOutput)
  else console.log(JSON.stringify((state.projects ?? []).map((name) => ({ 'Project Name': name }))))
} else if (command === 'pages project create') {
  if (state.createFails) {
    console.error('A request to the Cloudflare API failed. [code: 8000000]')
    process.exit(1)
  }
} else if (args[0] === 'pages' && args[1] === 'deploy') {
  const branch = args[args.indexOf('--branch') + 1]
  const entry = {
    type: 'pages-deploy-detailed',
    url: 'https://0123abcd.fxmusic.pages.dev',
    alias: (state.alias ?? {})[branch],
    environment: (state.environment ?? {})[branch] ?? (branch === 'main' ? 'production' : 'preview'),
  }
  fs.appendFileSync(
    process.env.WRANGLER_OUTPUT_FILE_PATH,
    JSON.stringify({ type: 'wrangler-session', version: 1 }) + '\\n' + JSON.stringify(entry) + '\\n',
  )
} else {
  process.exit(3)
}
`

const CURL_STUB = `#!/usr/bin/env node
const fs = require('fs')
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, 'utf8'))
const url = process.argv[process.argv.length - 1]
fs.appendFileSync(process.env.STUB_LOG, 'curl ' + url + '\\n')
if (state.detailsFail) {
  console.log('{"success":false,"errors":[{"code":8000007}]}')
  process.exit(22)
}
console.log(JSON.stringify({ success: true, result: { production_branch: state.productionBranch ?? 'main' } }))
`

/** A temporary checkout with deploy.sh, the scripts it sources, stand-ins and a dist folder. */
function checkout(state: StubState) {
  const root = tempDir()
  for (const file of [
    'scripts/env.sh',
    'scripts/lib.sh',
    'scripts/build-dist-wrangler/deploy.sh',
  ]) {
    writeFiles(root, { [file]: '' })
    copyFileSync(join(ROOT, file), join(root, file))
  }
  const wrangler = join(root, 'scripts/build-dist-wrangler/node_modules/wrangler/bin/wrangler.js')
  writeFiles(root, {
    'dist/pages/_headers': '/\n  X-Test: yes\n',
    'dist/pages/index.html': 'home',
    'stubs/curl': CURL_STUB,
    'state.json': JSON.stringify(state),
  })
  writeFiles(dirname(wrangler), { 'wrangler.js': WRANGLER_STUB })
  chmodSync(join(root, 'stubs/curl'), 0o755)
  return root
}

interface Run {
  status: number | null
  output: string
  /** The stand-ins' calls, one per line. */
  calls: string[]
  /** What the script wrote to GITHUB_OUTPUT. */
  outputs: Record<string, string>
}

function deploy(state: StubState, args: readonly string[], env: Record<string, string> = {}): Run {
  const root = checkout(state)
  const githubOutput = join(root, 'github-output')
  const log = join(root, 'calls.log')
  const result = spawnSync('bash', [join(root, 'scripts/build-dist-wrangler/deploy.sh'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'stubs')}:${process.env.PATH}`,
      HOME: root,
      STUB_STATE: join(root, 'state.json'),
      STUB_LOG: log,
      CLOUDFLARE_API_TOKEN: 'test-token',
      CLOUDFLARE_ACCOUNT_ID: 'test-account',
      GITHUB_OUTPUT: githubOutput,
      GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
      ...env,
    },
  })
  const outputs = existsSync(githubOutput)
    ? Object.fromEntries(
        readFileSync(githubOutput, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      )
    : {}
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
    outputs,
  }
}

const EXISTING: StubState = { projects: ['fxmusic', 'other'] }
const deployCall = (calls: readonly string[]) => calls.find((call) => call.includes('pages deploy'))

describe('deploy.sh', () => {
  it('deploys develop to its preview and reports the deployment', () => {
    const run = deploy({ ...EXISTING, alias: { develop: 'https://develop.fxmusic.pages.dev' } }, [
      'develop',
    ])
    expect(run.output).toContain('Deployed develop to https://0123abcd.fxmusic.pages.dev')
    expect(run.status).toBe(0)
    expect(deployCall(run.calls)).toMatch(
      /^wrangler pages deploy .*dist\/pages --project-name fxmusic --branch develop --commit-hash 0123456789abcdef0123456789abcdef01234567$/,
    )
    expect(run.calls).toContain(
      'curl https://api.cloudflare.com/client/v4/accounts/test-account/pages/projects/fxmusic',
    )
    expect(run.outputs).toEqual({
      url: 'https://0123abcd.fxmusic.pages.dev',
      alias: 'https://develop.fxmusic.pages.dev',
      environment: 'preview',
    })
  })

  it('deploys production when Cloudflare reports no alias', () => {
    const run = deploy(EXISTING, ['main'], { GITHUB_REF: 'refs/heads/main' })
    expect(run.status, run.output).toBe(0)
    expect(deployCall(run.calls)).toContain('--branch main ')
    expect(run.outputs).toEqual({
      url: 'https://0123abcd.fxmusic.pages.dev',
      alias: '',
      environment: 'production',
    })
  })

  it("deploys main's candidate to a preview first", () => {
    const run = deploy(EXISTING, ['main', '--candidate'], { GITHUB_REF: 'refs/heads/main' })
    expect(run.status, run.output).toBe(0)
    expect(deployCall(run.calls)).toContain('--branch main-candidate ')
    expect(run.outputs.environment).toBe('preview')
  })

  it('creates a missing project with main as its production branch', () => {
    const run = deploy({ projects: ['other'] }, ['develop'])
    expect(run.status, run.output).toBe(0)
    expect(run.calls).toContain('wrangler pages project create fxmusic --production-branch main')
  })

  it.each([
    [['feature/x'], {}, /usage: deploy\.sh develop \| main \[--candidate\]/],
    [['develop', '--candidate'], {}, /usage/],
    [['main', '--candidate', 'extra'], {}, /usage/],
    [[], {}, /usage/],
    [
      ['develop'],
      { GITHUB_REF: 'refs/heads/ci/2.8-deploy' },
      /a run of refs\/heads\/ci\/2\.8-deploy may not deploy develop/,
    ],
    [['main'], { GITHUB_REF: 'refs/tags/main' }, /may not deploy main/],
    [['develop'], { CLOUDFLARE_API_TOKEN: '' }, /CLOUDFLARE_API_TOKEN is not set/],
  ])('refuses %j (%j) before calling Cloudflare', (args, env, message) => {
    const run = deploy(EXISTING, args, env)
    expect(run.status).not.toBe(0)
    expect(run.output).toMatch(message)
    expect(run.calls).toEqual([])
  })

  it.each([
    [{ listFails: true }, /couldn't list the Pages projects/],
    [{ listOutput: 'Not JSON at all' }, /couldn't read wrangler's project list/],
    [
      { projects: [], createFails: true },
      /refused to create the Pages project fxmusic\. Code 8000000/,
    ],
    [{ ...EXISTING, detailsFail: true }, /couldn't read the Pages project fxmusic/],
    [{ ...EXISTING, productionBranch: 'develop' }, /deploys develop to production, not main/],
  ] as const)('stops before uploading when %j', (state, message) => {
    const run = deploy(state, ['develop'])
    expect(run.status).not.toBe(0)
    expect(run.output).toMatch(message)
    expect(deployCall(run.calls)).toBeUndefined()
  })

  it('fails when the deployment lands in the wrong environment', () => {
    const run = deploy({ ...EXISTING, environment: { develop: 'production' } }, ['develop'])
    expect(run.status).not.toBe(0)
    expect(run.output).toMatch(
      /the deployment of develop went to the production environment, not preview/,
    )
    expect(run.outputs).toEqual({})
  })

  it('finds the deployment record after other lines of wrangler output', () => {
    const run = deploy(
      {
        ...EXISTING,
        listOutput: `Notice: something\n${JSON.stringify([{ 'Project Name': 'fxmusic' }])}\n`,
      },
      ['develop'],
    )
    expect(run.status, run.output).toBe(0)
  })
})

it('keeps a usable copy of the scripts deploy.sh sources', () => {
  // The test copies these three files; a new dependency of deploy.sh must be copied too.
  const script = readFileSync(join(ROOT, 'scripts/build-dist-wrangler/deploy.sh'), 'utf8')
  expect([...script.matchAll(/^source "\$here\/(.+)"$/gm)].map(([, file]) => file)).toEqual([
    '../env.sh',
    '../lib.sh',
  ])
})
