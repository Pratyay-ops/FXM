import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MANIFEST_NAME, releaseFiles, TARGETS } from '../release/targets.ts'
import { THROWAWAY_SUBJECT, type WindowsSigning } from '../release/windows-signing.ts'

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
const certificateScript = read('../release/windows-certificate.ps1')

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

/** A workflow's text without its comments, which name tools the code doesn't run. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

/** The ids of a workflow's jobs, in order. */
const jobIds = (source: string): string[] =>
  [...source.slice(source.indexOf('\njobs:\n')).matchAll(/^ {2}([\w-]+):$/gm)].map(
    ([, id]) => id ?? '',
  )

/** The actions a job uses, without their versions. */
const actionsOf = (jobText: string) =>
  [...code(jobText).matchAll(/uses: ([\w.-]+\/[\w.-]+)@/g)].map(([, action]) => action)

// --- GitHub's rules for which jobs run ---------------------------------------------------------

/** A value of a GitHub Actions expression. */
type Value = string | number | boolean | null

/** Whether GitHub takes a value as true: anything but false, 0, '', null and NaN. */
const truthy = (value: Value) =>
  value !== false && value !== null && value !== '' && value !== 0 && !Number.isNaN(value)

/**
 * Evaluates a GitHub Actions expression (GitHub's docs, "Evaluate expressions in workflows and
 * actions"): literals, contexts, calls without arguments, `!`, `==`, `!=`, `&&`, `||` and
 * parentheses, in that order of precedence. Strings compare without case, values of different
 * types as numbers.
 */
function evaluate(
  expression: string,
  context: (path: string) => Value,
  call: (name: string) => Value,
): Value {
  const tokens =
    expression.match(/'(?:[^']|'')*'|&&|\|\||[!=]=|[!()]|[A-Za-z_][\w.-]*(?:\(\))?|\S+/g) ?? []
  let at = 0
  function take(expected?: string): string {
    const token = tokens[at++]
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`${expression}: expected ${expected ?? 'more'}, got ${token ?? 'the end'}`)
    }
    return token
  }
  const number = (value: Value) => (value === null ? 0 : Number(value))
  function equal(a: Value, b: Value): boolean {
    if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase()
    return typeof a === typeof b ? a === b : number(a) === number(b)
  }
  function primary(): Value {
    const token = take()
    if (token === '(') {
      const value = or()
      take(')')
      return value
    }
    if (token === '!') return !truthy(primary())
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'")
    if (token === 'true' || token === 'false') return token === 'true'
    if (token === 'null') return null
    if (token.endsWith('()')) return call(token.slice(0, -2))
    if (/^[A-Za-z_]/.test(token)) return context(token)
    throw new Error(`${expression}: unexpected ${token}`)
  }
  function comparison(): Value {
    let left = primary()
    while (tokens[at] === '==' || tokens[at] === '!=') {
      const differ = take() === '!='
      left = equal(left, primary()) !== differ
    }
    return left
  }
  function and(): Value {
    let left = comparison()
    while (tokens[at] === '&&') {
      take()
      const right = comparison()
      left = truthy(left) ? right : left
    }
    return left
  }
  function or(): Value {
    let left = and()
    while (tokens[at] === '||') {
      take()
      const right = and()
      left = truthy(left) ? left : right
    }
    return left
  }
  const value = or()
  if (at < tokens.length) throw new Error(`${expression}: unexpected ${tokens[at]}`)
  return value
}

/** A job's `if`, its folded lines joined, without `${{ }}`; undefined without one. */
function jobCondition(jobText: string): string | undefined {
  const match = /^ {4}if: (?:>-\n((?: {6}.+\n)+)|(.+)\n)/m.exec(jobText)
  if (!match) return undefined
  const text =
    match[1] === undefined
      ? (match[2] ?? '')
      : match[1]
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .join(' ')
  return /^\$\{\{ (.*) \}\}$/s.exec(text)?.[1] ?? text
}

/** What decides whether a job runs: its needs and its `if`. */
interface JobSpec {
  readonly id: string
  readonly needs: readonly string[]
  readonly condition: string | undefined
}

/** A workflow's jobs, in order, with their needs and conditions. */
function jobSpecs(source: string): JobSpec[] {
  return jobIds(source).map((id) => {
    const text = job(source, id)
    const needs = /^ {4}needs: (.+)$/m.exec(text)?.[1] ?? ''
    return {
      id,
      needs: needs
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((need) => need.trim())
        .filter(Boolean),
      condition: jobCondition(text),
    }
  })
}

type JobResult = 'success' | 'failure' | 'skipped'

/** How a simulated run goes. */
interface Run {
  /** The outputs of each job that succeeds. */
  readonly outputs?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** The jobs that fail if they run. */
  readonly failing?: readonly string[]
  readonly cancelled?: boolean
}

/**
 * Which jobs of a workflow run, by GitHub's rules (GitHub's docs, "Using jobs in a workflow" and
 * "Evaluate expressions in workflows and actions"): a job runs when its `if` holds, where an `if`
 * that calls no status function means `success() && (if)`, and no `if` means `success()`. For a
 * job, success() holds only when every job before it succeeded, the needs of its needs included,
 * so a job skipped anywhere before skips it, even after a job that ran anyway
 * (actions/runner#491). The `needs` context holds the job's own needs alone.
 */
function simulate(jobs: readonly JobSpec[], run: Run = {}): Record<string, JobResult> {
  const results: Record<string, JobResult> = {}
  const needsOf = new Map(jobs.map(({ id, needs }) => [id, needs]))
  const before = (id: string): string[] => [
    ...new Set((needsOf.get(id) ?? []).flatMap((need) => [need, ...before(need)])),
  ]
  for (const { id, needs, condition = 'success()' } of jobs) {
    const earlier = before(id).map((other) => {
      const result = results[other]
      if (result === undefined) throw new Error(`${id} needs ${other}, which doesn't come first`)
      return result
    })
    const status: Readonly<Record<string, boolean>> = {
      always: true,
      cancelled: run.cancelled === true,
      success: run.cancelled !== true && earlier.every((result) => result === 'success'),
      failure: earlier.includes('failure'),
    }
    const context = (path: string): Value => {
      const [name, need = '', field, output] = path.split('.')
      if (name === 'needs' && needs.includes(need)) {
        if (field === 'result') return results[need] ?? null
        if (field === 'outputs' && output !== undefined) {
          return results[need] === 'success' ? (run.outputs?.[need]?.[output] ?? '') : ''
        }
      }
      throw new Error(`${id}'s if reads ${path}, which this model doesn't know`)
    }
    const call = (name: string): Value => {
      const value = status[name]
      if (value === undefined) throw new Error(`${id}'s if calls ${name}()`)
      return value
    }
    const explicit = /\b(?:success|failure|cancelled|always)\(\)/.test(condition)
    const runs = truthy(
      evaluate(explicit ? condition : `success() && (${condition})`, context, call),
    )
    results[id] = !runs ? 'skipped' : run.failing?.includes(id) ? 'failure' : 'success'
  }
  return results
}

/** The Windows jobs, in the order they run. */
const WINDOWS_JOBS = [
  'windows-build',
  'windows-sign-app',
  'windows-bundle',
  'windows-sign-installers',
  'windows-check',
]

/** The two jobs that sign the Windows files, and so the only ones with the certificate. */
const SIGNING_JOBS = ['windows-sign-app', 'windows-sign-installers']

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
    // The build job's matrix, and Windows in jobs of its own.
    const windows = job(workflow, 'windows-build')
    const env = (name: string) => new RegExp(`^ {6}${name}: (.+)$`, 'm').exec(windows)?.[1]
    const built = [
      ...matrix(),
      {
        target: env('TARGET'),
        os: /^ {4}runs-on: (.+)$/m.exec(windows)?.[1],
        triple: env('TRIPLE'),
        bundles: /--bundles (\S+)/.exec(windows)?.[1],
      },
    ]
    const byTarget = (a: { target: string | undefined }, b: { target: string | undefined }) =>
      String(a.target).localeCompare(String(b.target))
    expect(
      built.map(({ target, triple, bundles }) => ({ target, triple, bundles })).sort(byTarget),
    ).toEqual(
      TARGETS.map(({ id, triple, bundles }) => ({ target: id, triple, bundles })).sort(byTarget),
    )
    expect(built.map(({ os }) => os)).toEqual([
      'macos-latest',
      'macos-latest',
      'ubuntu-22.04',
      'ubuntu-22.04-arm',
      'windows-latest',
    ])
    // windows-bundle makes the same installers for the same target.
    const bundle = job(workflow, 'windows-bundle')
    expect(bundle).toContain('pnpm tauri bundle --target "$TRIPLE" --bundles nsis,msi')
    expect(bundle).toMatch(/^ {6}TRIPLE: x86_64-pc-windows-msvc$/m)
  })

  it('installs the Rust release and components of rust-toolchain.toml on Windows, with its target', () => {
    const channel = /^channel = "([^"]+)"$/m.exec(toolchainToml)?.[1]
    const components = tomlStrings(/^components = \[([^\]]*)\]$/m.exec(toolchainToml)?.[1])
    // windows-build compiles, and windows-bundle's Tauri CLI asks cargo about the project.
    for (const id of ['windows-build', 'windows-bundle']) {
      const windows = job(workflow, id)
      expect(windows).toContain('dtolnay/rust-toolchain@')
      const toolchains = [...windows.matchAll(/^\s+toolchain: (\S+)$/gm)].map(([, value]) => value)
      expect(toolchains).toEqual([channel])
      expect(/^\s+components: (.+)$/m.exec(windows)?.[1]?.split(/[\s,]+/)).toEqual(components)
      expect(/^\s+targets: (.+)$/m.exec(windows)?.[1]).toBe('x86_64-pc-windows-msvc')
    }
    expect(workflow.match(/dtolnay\/rust-toolchain@/g)).toHaveLength(2)
  })

  it('builds with tauri-action, which creates no release and uploads nothing', () => {
    for (const id of ['build', 'windows-build']) {
      const build = steps(job(workflow, id)).find((step) =>
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
    }
    // So does windows-bundle's tauri bundle.
    expect(job(workflow, 'windows-bundle')).toMatch(
      /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ steps\.build-key\.outputs\.key \}\}/,
    )
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
    expect(job(workflow, 'windows-build')).toMatch(/^ {4}needs: check$/m)
  })

  it('uploads release-desktop, the artifact release.yml publishes', () => {
    expect(job(workflow, 'sign')).toMatch(/name: release-desktop\n\s+path: dist\/release-desktop\//)
  })

  it('builds without caches, as release.yml does', () => {
    expect(workflow).not.toContain('actions/cache@')
  })

  it('runs Windows in five jobs, and ships unsigned installers only without a certificate', () => {
    const ids = jobIds(workflow)
    expect(ids.filter((id) => id.startsWith('windows-'))).toEqual(WINDOWS_JOBS)
    const needs = (id: string) => /^ {4}needs: (.+)$/m.exec(job(workflow, id))?.[1]
    expect(needs('windows-sign-app')).toBe('[check, windows-build]')
    expect(needs('windows-bundle')).toBe('[check, windows-sign-app]')
    expect(needs('windows-sign-installers')).toBe('[check, windows-sign-app, windows-bundle]')
    expect(needs('windows-check')).toBe(
      '[check, windows-build, windows-sign-app, windows-sign-installers]',
    )
    expect(needs('sign')).toBe('[check, build, windows-check]')
    // A condition of its own, without which GitHub would skip it after the jobs that a release
    // without a certificate skips (the simulated runs below).
    expect(jobCondition(job(workflow, 'sign'))).toBe(
      "!cancelled() && needs.check.result == 'success' && needs.build.result == 'success' && needs.windows-check.result == 'success'",
    )
    // Without a certificate, a release skips bundling and signing again...
    for (const id of ['windows-bundle', 'windows-sign-installers']) {
      expect(job(workflow, id)).toContain("if: needs.windows-sign-app.outputs.signing != 'none'")
    }
    // ...and the check takes windows-build's unsigned installers, never otherwise.
    const check = job(workflow, 'windows-check')
    expect(check).toContain("&& needs.windows-sign-installers.result == 'skipped')) }}")
    expect(check).toContain(
      `name: ${expression("needs.windows-sign-app.outputs.signing == 'none' && 'windows-unsigned' || 'windows-signed-installers'")}`,
    )
    // Only the check hands the installers to the sign job, under the name it gathers.
    expect([...workflow.matchAll(/name: desktop-windows-x64$/gm)]).toHaveLength(1)
    expect(check).toMatch(/name: desktop-windows-x64\n\s+path: dist\/desktop\//)
    // The others' artifacts, which the sign job's `desktop-*` never gathers.
    const uploads = (id: string) =>
      [
        ...job(workflow, id).matchAll(
          /upload-artifact@[^\n]+\n\s+(?:if: .+\n\s+)?with:\n\s+name: (\S+)/g,
        ),
      ].map(([, name]) => name)
    expect(WINDOWS_JOBS.map(uploads)).toEqual([
      ['windows-app', 'windows-to-sign', 'windows-unsigned'],
      ['windows-signed-app'],
      ['windows-installers'],
      ['windows-signed-installers'],
      ['desktop-windows-x64'],
    ])
  })

  it('keeps the Windows certificate in two jobs that run none of the build’s code', () => {
    // Only the signing jobs read the secrets, and only they name the environment.
    const reading = jobIds(workflow).filter((id) =>
      /secrets\.WINDOWS_CERTIFICATE/.test(job(workflow, id)),
    )
    expect(reading).toEqual(SIGNING_JOBS)
    const naming = jobIds(workflow).filter((id) => job(workflow, id).includes("'windows-signing'"))
    expect(naming).toEqual(SIGNING_JOBS)
    for (const id of SIGNING_JOBS) {
      const signing = job(workflow, id)
      expect(signing).toContain(
        `environment: ${expression("inputs.release && 'windows-signing' || ''")}`,
      )
      // GitHub's own actions, and no package manager, toolchain, Tauri, cargo or unpacker: the
      // key meets no code of the build, nor files the build made run as programs.
      expect(new Set(actionsOf(signing))).toEqual(
        new Set([
          'actions/checkout',
          'actions/setup-node',
          'actions/download-artifact',
          'actions/upload-artifact',
        ]),
      )
      expect(code(signing)).not.toMatch(
        /\b(pnpm|npm|npx|make|cargo|rustup|apt-get|7z|msiexec|tauri-apps|tauri)\b/,
      )
      // The values reach one step, which runs the repository's PowerShell script only.
      const holding = steps(signing).filter((step) =>
        /secrets\.WINDOWS_CERTIFICATE(?:_PASSWORD)?\b(?! != '')/.test(step),
      )
      expect(holding).toHaveLength(1)
      const certificate = holding[0] ?? ''
      expect(certificate).toMatch(/shell: pwsh\n/)
      expect(certificate).not.toMatch(/\buses: /)
      expect(certificate).toContain(
        "run: '& ./apps/desktop/release/windows-certificate.ps1 -Signing $env:SIGNING'",
      )
      expect(certificate).toMatch(
        /WINDOWS_CERTIFICATE: \$\{\{ [\w.-]+ == 'certificate' && secrets\.WINDOWS_CERTIFICATE \|\| '' \}\}/,
      )
      // signtool signs through this repository's script, then the certificate leaves the store.
      expect(signing).toContain('release.ts windows-sign --phase')
      const removal = steps(signing).find((step) => step.includes('-DeleteKey'))
      expect(removal).toContain("if: always() && steps.certificate.outputs.thumbprint != ''")
      expect(removal).toContain(
        'Remove-Item -LiteralPath "Cert:\\CurrentUser\\My\\$env:THUMBPRINT" -DeleteKey',
      )
    }
    // The first learns only whether the environment holds a certificate; the second does as the
    // first did.
    const choose = steps(job(workflow, 'windows-sign-app')).find((step) =>
      step.includes('release.ts windows-signing --mode'),
    )
    expect(choose).toContain(`MODE: ${expression("inputs.release && 'release' || 'dry-run'")}`)
    expect(choose).toContain(
      `HAS_CERTIFICATE: ${expression("secrets.WINDOWS_CERTIFICATE != '' && 'yes' || ''")}`,
    )
    // A dry run may ask to sign nothing, which release.ts refuses for a release.
    expect(choose).toContain(`UNSIGNED: ${expression("inputs.windows-unsigned && 'yes' || ''")}`)
    expect(choose).toContain('--certificate "$HAS_CERTIFICATE" --unsigned "$UNSIGNED"')
    expect(job(workflow, 'windows-sign-installers')).toContain(
      `SIGNING: ${expression('needs.windows-sign-app.outputs.signing')}`,
    )
  })

  it('builds and bundles Windows with Tauri’s signing hooked to collect, then swap in, the signed files', () => {
    for (const id of ['windows-build', 'windows-bundle']) {
      const building = job(workflow, id)
      // No environment, no secrets: these jobs run the build's code.
      expect(building).not.toMatch(/^ {4}environment:/m)
      expect(code(building)).not.toContain('secrets.')
      expect(code(building)).not.toContain('signtool')
    }
    const build = job(workflow, 'windows-build')
    expect(build).toContain('release.ts windows-hook-config --mode collect')
    const tauri = steps(build).find((step) => step.includes('tauri-apps/tauri-action@'))
    expect(tauri).toContain(expression('steps.hook.outputs.config-args'))
    expect(tauri).toContain('--target x86_64-pc-windows-msvc --bundles nsis,msi')
    expect(build).toContain('release.ts windows-collected --dir "$RUNNER_TEMP/to-sign"')
    const bundle = job(workflow, 'windows-bundle')
    expect(bundle).toContain('release.ts windows-hook-config --mode swap')
    expect(bundle).toContain(`HOOK_ARGS: ${expression('steps.hook.outputs.config-args')}`)
    expect(bundle).toContain('release.ts windows-swapped --dir "$RUNNER_TEMP/signed-app"')
    // The fxm.exe that windows-build compiled, not one of its own.
    expect(bundle).not.toContain('tauri build')
    expect(bundle).toMatch(
      /name: windows-app\n\s+path: apps\/desktop\/src-tauri\/target\/x86_64-pc-windows-msvc\/release\n/,
    )
  })

  it('checks every Windows file’s signature, which a release without a certificate must lack', () => {
    const check = steps(job(workflow, 'windows-check')).find((step) =>
      step.includes('release.ts windows-signatures'),
    )
    expect(check).toContain('Get-AuthenticodeSignature')
    // Both installers, the fxm.exe inside each and the NSIS plugins, unpacked here.
    expect(check).toContain('Get-Item -Path dist/desktop/*.msi')
    expect(check).toContain('Get-Item -Path dist/desktop/*-setup.exe')
    expect(check).toContain('\'/a\', "`"$($msi.FullName)`"", \'/qn\'')
    expect(check).toContain('7z x $setup.FullName')
    expect(check).toContain('fxm.exe in $($msi.Name)')
    expect(check).toContain('fxm.exe in $($setup.Name)')
    expect(check).toContain("role = 'plugin'")
    expect(check).toContain('--thumbprint "$env:THUMBPRINT" --app-thumbprint "$env:APP_THUMBPRINT"')
    expect(check).toContain(
      `APP_THUMBPRINT: ${expression('needs.windows-sign-app.outputs.thumbprint')}`,
    )
    expect(check).toContain(
      `THUMBPRINT: ${expression('needs.windows-sign-installers.outputs.thumbprint')}`,
    )
    expect(check).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }')
    // The check unpacks what the build made, so it runs where no key is.
    expect(job(workflow, 'windows-check')).not.toMatch(/^ {4}environment:/m)
    expect(code(job(workflow, 'windows-check'))).not.toContain('secrets.')
  })

  it('takes the Windows certificate from the environment, which release.yml passes on by name', () => {
    const declared = /^ {4}secrets:\n((?: {6}.*\n)+)/m.exec(workflow)?.[1] ?? ''
    expect([...declared.matchAll(/^ {6}(\w+):$/gm)].map(([, name]) => name)).toEqual([
      'TAURI_SIGNING_PRIVATE_KEY',
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
      'WINDOWS_CERTIFICATE',
      'WINDOWS_CERTIFICATE_PASSWORD',
    ])
  })

  it('checks the macOS signature is ad hoc and the .deb asks for GStreamer', () => {
    expect(workflow).toMatch(/grep -qx 'Signature=adhoc'/)
    expect(workflow).toContain(
      'for package in gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-libav',
    )
    expect(workflow).toContain('apps/desktop/release/gstreamer-check.sh')
  })
})

describe('which jobs of desktop-release.yml run, by GitHub’s rules for needs and if', () => {
  const jobs = jobSpecs(workflow)
  /** A run in which windows-sign-app chooses how to sign. */
  const signing = (how: WindowsSigning): Run => ({
    outputs: { 'windows-sign-app': { signing: how, thumbprint: '0'.repeat(40) } },
  })

  it('follows GitHub: a job skipped anywhere before skips a job whose if calls no status function', () => {
    // actions/runner#491: b runs anyway, and c, which needs b alone, is skipped all the same.
    const chain: JobSpec[] = [
      { id: 'a', needs: [], condition: 'false' },
      { id: 'b', needs: ['a'], condition: 'always()' },
      { id: 'c', needs: ['b'], condition: undefined },
      { id: 'd', needs: ['b'], condition: "!cancelled() && needs.b.result == 'success'" },
    ]
    expect(simulate(chain)).toEqual({ a: 'skipped', b: 'success', c: 'skipped', d: 'success' })
  })

  it('runs every job of a dry run, and of a release with a certificate', () => {
    for (const how of ['throwaway', 'certificate'] as const) {
      const results = simulate(jobs, signing(how))
      expect(Object.keys(results)).toEqual(jobIds(workflow))
      expect(new Set(Object.values(results)), how).toEqual(new Set(['success']))
    }
  })

  it('signs the updates of a release without a Windows certificate, unsigned installers included', () => {
    // So does a dry run with windows-unsigned, for which windows-sign-app chooses none too.
    expect(simulate(jobs, signing('none'))).toEqual({
      check: 'success',
      build: 'success',
      'windows-build': 'success',
      'windows-sign-app': 'success',
      'windows-bundle': 'skipped',
      'windows-sign-installers': 'skipped',
      'windows-check': 'success',
      sign: 'success',
    })
    // Without its condition, GitHub would skip it there, and release.yml would publish nothing.
    const implicit = jobs.map((spec) =>
      spec.id === 'sign' ? { ...spec, condition: undefined } : spec,
    )
    expect(simulate(implicit, signing('none')).sign).toBe('skipped')
  })

  it('signs no update once a job before it fails, or the run is cancelled', () => {
    for (const how of ['certificate', 'none'] as const) {
      const ran = Object.entries(simulate(jobs, signing(how)))
        .filter(([id, result]) => id !== 'sign' && result === 'success')
        .map(([id]) => id)
      expect(ran.length, how).toBeGreaterThan(4)
      for (const failing of ran) {
        const results = simulate(jobs, { ...signing(how), failing: [failing] })
        expect(results.sign, `${failing} fails (${how})`).toBe('skipped')
      }
      expect(simulate(jobs, { ...signing(how), cancelled: true }).sign, how).toBe('skipped')
    }
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
    // By name: GitHub hands an environment's secrets to a called workflow's job only when the
    // caller passes them, even though they exist in the environment alone.
    const secrets = [...desktopJob.matchAll(/^ {6}(\w+): \$\{\{ secrets\.(\w+) \}\}$/gm)]
    expect(secrets.map(([, name, secret]) => [name, secret])).toEqual([
      ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY'],
      ['TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'],
      ['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE'],
      ['WINDOWS_CERTIFICATE_PASSWORD', 'WINDOWS_CERTIFICATE_PASSWORD'],
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

  it('lets a dry run sign no Windows file, as a release without a certificate, which no release asks', () => {
    expect(desktop).toMatch(/^ {6}windows-unsigned:\n {8}description: .+\n {8}type: boolean\n/m)
    expect(job(desktop, 'release-dry-run')).toContain(
      `windows-unsigned: ${expression('inputs.windows-unsigned')}`,
    )
    expect(workflow).toMatch(
      /^ {6}windows-unsigned:\n {8}description: .+\n {8}required: false\n {8}type: boolean\n {8}default: false\n/m,
    )
    expect(job(release, 'desktop')).not.toContain('windows-unsigned')
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

describe('windows-certificate.ps1', () => {
  it('imports a certificate with a key that can’t be exported again, and deletes its file', () => {
    expect(certificateScript).toContain("[ValidateSet('certificate', 'throwaway')]")
    const imported = /Import-PfxCertificate[^\n]*/.exec(certificateScript)?.[0]
    expect(imported).toBe('Import-PfxCertificate @import |')
    expect(certificateScript).not.toMatch(/-Exportable\b/)
    expect(certificateScript).toMatch(/\} finally \{\n\s+Remove-Item -LiteralPath \$pfx -Force\n/)
    expect(certificateScript).toContain('Where-Object { $_.HasPrivateKey }')
    expect(certificateScript).toContain(
      '"thumbprint=$($imported.Thumbprint)" >> $env:GITHUB_OUTPUT',
    )
  })

  it('takes a file without a password', () => {
    expect(certificateScript).toMatch(
      /if \(\$password -ne ''\) \{\n\s+\$import\.Password = ConvertTo-SecureString \$password -AsPlainText -Force\n/,
    )
  })

  it('gives every dry run a throwaway certificate through the release’s own path', () => {
    expect(certificateScript).toContain(`-Subject '${THROWAWAY_SUBJECT}'`)
    // Made exportable only to be exported, with a random password, then taken out of the store
    // before the import that a release's certificate gets.
    expect(certificateScript).toContain('-KeyExportPolicy Exportable')
    expect(certificateScript).toContain('Export-PfxCertificate -Cert $made')
    expect(certificateScript).toContain(
      '[Security.Cryptography.RandomNumberGenerator]::GetBytes(24)',
    )
    expect(certificateScript).toContain(
      'Remove-Item -LiteralPath "Cert:\\CurrentUser\\My\\$($made.Thumbprint)" -DeleteKey',
    )
    const made = certificateScript.indexOf('New-SelfSignedCertificate')
    const shared = certificateScript.indexOf('# From here on, the same for both.')
    expect(made).toBeGreaterThan(0)
    expect(shared).toBeGreaterThan(made)
    expect(certificateScript.indexOf('Import-PfxCertificate')).toBeGreaterThan(shared)
  })
})
