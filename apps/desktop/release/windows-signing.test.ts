import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Reporter } from './actions.ts'
import { main } from './release.ts'
import { temporaryFolder } from './testing.ts'
import {
  APP_BINARY,
  appCopyProblems,
  BUNDLE_TYPE_PREFIX,
  COLLECTED_LIST,
  checkWindowsSignatures,
  chooseWindowsSigning,
  classifyFile,
  collectedProblems,
  DEFAULT_TIMESTAMP_URL,
  type FileSignature,
  findSigntool,
  hookConfig,
  installerProblems,
  keptName,
  PINNED_PLUGINS,
  parseSignatureReport,
  parseThumbprint,
  parseTimestampUrl,
  parseWindowsSigning,
  type RunSigntool,
  readCollected,
  runHook,
  SIGNED_LIST,
  signApp,
  signFiles,
  signInstallers,
  signtoolArgs,
  swapProblems,
  type WindowsSignOptions,
  writeHookConfig,
} from './windows-signing.ts'

const THUMBPRINT = '0123456789ABCDEF0123456789ABCDEF01234567'
const OTHER = 'FEDCBA9876543210FEDCBA9876543210FEDCBA98'
const VERSION = '0.7.0'
const SETUP = `fxm-desktop-${VERSION}-windows-x64-setup.exe`
const MSI = `fxm-desktop-${VERSION}-windows-x64.msi`

function recorder() {
  const lines: string[] = []
  const reporter: Reporter = {
    info: (m) => lines.push(`info ${m}`),
    notice: (t, m) => lines.push(`notice ${t}: ${m}`),
    error: (t, m) => lines.push(`error ${t}: ${m}`),
    output: (n, v) => lines.push(`output ${n}=${v}`),
    summary: (m) => lines.push(`summary ${m}`),
  }
  return { lines, reporter }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

let folder: string
beforeEach(() => {
  folder = temporaryFolder('windows-signing')
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

/** A stand-in for fxm.exe, patched for one installer as Tauri's bundler does. */
function app(type: string): Buffer {
  return Buffer.concat([
    Buffer.from('MZ fxm.exe, the code before it '),
    Buffer.from(`${BUNDLE_TYPE_PREFIX}${type}`, 'latin1'),
    Buffer.from(' and after it'),
  ])
}

/** Two stand-in NSIS plugins, and the pins that trust them. */
const PLUGINS = {
  'System.dll': Buffer.from('MZ System.dll'),
  'nsDialogs.dll': Buffer.from('MZ nsDialogs'),
}
const PINS = Object.fromEntries(
  Object.entries(PLUGINS).map(([name, bytes]) => [name, sha256(bytes)]),
)

/** Where Tauri hands the hook each file on Windows, with its mix of `\` and `/`. */
const RELEASE = 'D:\\a\\FXM\\FXM\\apps\\desktop\\src-tauri\\target\\x86_64-pc-windows-msvc\\release'
const PLUGIN_FOLDER = `${RELEASE}\\nsis\\x64\\Plugins\\x86-unicode`

/**
 * Writes `bytes` to a file named like Tauri's, in a folder of its own (under `within`), and
 * returns its path.
 */
function tauriFile(name: string, bytes: Uint8Array, within = ''): string {
  const where = join(folder, 'tauri', String(Math.random()).slice(2), within)
  mkdirSync(where, { recursive: true })
  const path = join(where, name)
  writeFileSync(path, bytes)
  return path
}

/** An NSIS plugin where Tauri's bundler signs it: its copy of NSIS's plugins folder. */
const pluginFile = (name: string, bytes: Uint8Array) =>
  tauriFile(name, bytes, join('nsis', 'x64', 'Plugins', 'x86-unicode'))

/** Has the hook collect both copies of fxm.exe and the plugins, as `tauri build` does. */
function collectAll(dir: string, plugins: Record<string, Uint8Array> = PLUGINS) {
  runHook('collect', dir, tauriFile(APP_BINARY, app('NSS')))
  for (const [name, bytes] of Object.entries(plugins))
    runHook('collect', dir, pluginFile(name, bytes))
  runHook('collect', dir, tauriFile('nstD73E.tmp', Buffer.from('MZ uninstaller')))
  runHook('collect', dir, tauriFile(APP_BINARY, app('MSI')))
  runHook('collect', dir, tauriFile('WixUtilExtension.dll', Buffer.from('MZ wix'), 'wix'))
}

/** signtool, as the tests see it: it records its arguments and appends a "signature". */
function fakeSigntool(status: number[] = []) {
  const calls: (readonly string[])[] = []
  const run = vi.fn((args: readonly string[]) => {
    calls.push(args)
    const next = status.shift() ?? 0
    if (next === 0) {
      for (const file of args.slice(args.indexOf('sha256', args.indexOf('/td')) + 1)) {
        writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from(' SIGNED')]))
      }
    }
    return next
  })
  return { calls, run }
}

const signing = (run: RunSigntool, wait = vi.fn()): WindowsSignOptions => ({
  thumbprint: THUMBPRINT,
  timestampUrl: '',
  run,
  wait,
})

describe('how the Windows files are signed', () => {
  it('with a throwaway certificate in every dry run', () => {
    expect(chooseWindowsSigning('dry-run', false)).toBe('throwaway')
    // A dry run never uses the release certificate, which it can't read anyway.
    expect(chooseWindowsSigning('dry-run', true)).toBe('throwaway')
  })

  it('with the environment’s certificate in a release, and not at all without one', () => {
    expect(chooseWindowsSigning('release', true)).toBe('certificate')
    expect(chooseWindowsSigning('release', false)).toBe('none')
  })

  it('not at all in a dry run that tries a release without a certificate', () => {
    expect(chooseWindowsSigning('dry-run', false, true)).toBe('none')
    expect(chooseWindowsSigning('dry-run', true, true)).toBe('none')
    // A release with a certificate signs, whatever it is asked.
    expect(() => chooseWindowsSigning('release', true, true)).toThrow('for dry runs')
    expect(() => chooseWindowsSigning('release', false, true)).toThrow('for dry runs')
  })

  it('reads --signing', () => {
    expect(parseWindowsSigning('certificate')).toBe('certificate')
    expect(() => parseWindowsSigning('signpath')).toThrow('--signing must be')
  })

  it('refuses what isn’t a thumbprint or a timestamp server', () => {
    expect(parseThumbprint(` ${THUMBPRINT.toLowerCase()} `)).toBe(THUMBPRINT)
    for (const value of ['', '0123', `${THUMBPRINT}00`, 'G'.repeat(40), `"${THUMBPRINT}"`]) {
      expect(() => parseThumbprint(value), value).toThrow('not a certificate thumbprint')
    }
    expect(parseTimestampUrl('')).toBe(DEFAULT_TIMESTAMP_URL)
    expect(parseTimestampUrl('http://timestamp.digicert.com')).toBe('http://timestamp.digicert.com')
    for (const value of ['time.certum.pl', 'ftp://time.certum.pl', 'file:///etc/passwd']) {
      expect(() => parseTimestampUrl(value), value).toThrow('timestamp server')
    }
  })
})

describe('the hook in Tauri’s signing', () => {
  it('runs this folder’s release.ts with the files Tauri hands it, in paths NSIS can run', () => {
    const config = hookConfig('collect', 'D:\\a\\_temp\\to-sign', 'C:\\node\\node.exe')
    const { cmd, args } = config.bundle.windows.signCommand
    expect(cmd).toBe('C:/node/node.exe')
    expect(args.slice(0, 2)).toEqual([
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
    ])
    expect(args[2]).toMatch(/\/apps\/desktop\/release\/release\.ts$/)
    expect(args.slice(3, 6)).toEqual(['windows-hook', '--mode', 'collect'])
    expect(args.at(-2)).toBe('--file')
    expect(args.at(-1)).toBe('%1')
    // Never a `\`: Tauri hands NSIS the command in Rust's debug notation, which doubles them.
    expect(JSON.stringify(config)).not.toContain('\\\\')
  })

  it('is written for tauri build and tauri bundle --config, with its folder ready', () => {
    const hook = join(folder, 'hook')
    const dir = join(folder, 'to-sign')
    const args = writeHookConfig(hook, 'swap', dir, '/usr/bin/node')
    const path = join(hook, 'windows-swap.conf.json')
    expect(args).toBe(`--config ${path}`)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(hookConfig('swap', dir, '/usr/bin/node'))
    expect(readdirSync(dir)).toEqual([])
  })

  it('tells fxm.exe and the NSIS plugins from what it doesn’t collect', () => {
    expect(classifyFile(`${RELEASE}\\fxm.exe`)).toBe('app')
    expect(classifyFile(`${PLUGIN_FOLDER}\\System.dll`)).toBe('plugin')
    expect(classifyFile(`${PLUGIN_FOLDER}\\additional/nsis_tauri_utils.dll`)).toBe('plugin')
    for (const other of [
      'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\nstD73E.tmp',
      `${RELEASE}\\wix\\x64\\wix\\WixUtilExtension.dll`,
      `${RELEASE}\\bundle/nsis/FXM_0.7.0_x64-setup.exe`,
      `${RELEASE}\\bundle/msi/FXM_0.7.0_x64_en-US.msi`,
    ]) {
      expect(classifyFile(other), other).toBe('other')
    }
  })

  it('collects fxm.exe, once for each installer, and the plugins, and signs nothing', () => {
    const dir = join(folder, 'to-sign')
    const appPath = tauriFile(APP_BINARY, app('NSS'))
    expect(runHook('collect', dir, appPath)).toMatch(/^fxm\.exe: collected to be signed \(app, /)
    expect(readFileSync(appPath)).toEqual(app('NSS'))
    expect(runHook('collect', dir, tauriFile('nstD73E.tmp', Buffer.from('MZ')))).toBe(
      'nstD73E.tmp: not collected (signed later, or not at all)',
    )
    collectAll(dir)
    const collected = readCollected(dir)
    expect(collected.map(({ kind, name }) => [kind, name])).toEqual([
      ['app', 'fxm.exe'],
      ['plugin', 'System.dll'],
      ['plugin', 'nsDialogs.dll'],
      ['app', 'fxm.exe'],
    ])
    expect(readdirSync(dir).sort()).toEqual(
      [COLLECTED_LIST, ...collected.map((file) => keptName(file))].sort(),
    )
    expect(collectedProblems(dir, collected, PINS)).toEqual([])
  })

  it('refuses a list with anything but files it collected', () => {
    const dir = join(folder, 'to-sign')
    expect(() => readCollected(dir)).toThrow('never ran the hook')
    mkdirSync(dir)
    writeFileSync(join(dir, COLLECTED_LIST), '{"sha256":"00","kind":"app","name":"fxm.exe"}\n')
    expect(() => readCollected(dir)).toThrow('not a collected file')
    const hash = 'a'.repeat(64)
    writeFileSync(
      join(dir, COLLECTED_LIST),
      `${JSON.stringify({ sha256: hash, kind: 'plugin', name: '../../evil.dll' })}\n`,
    )
    expect(() => readCollected(dir)).toThrow('not a collected file')
  })
})

describe('what windows-sign-app signs', () => {
  it('two copies of fxm.exe that differ in their bundle type alone', () => {
    expect(appCopyProblems(app('NSS'), app('MSI'))).toEqual([])
    expect(appCopyProblems(app('MSI'), app('NSS'))).toEqual([])
    expect(appCopyProblems(app('NSS'), app('NSS'))).toEqual([
      'the two copies of fxm.exe are the same: no bundle type in them',
    ])
    const length = app('NSS').length
    expect(appCopyProblems(app('NSS'), Buffer.concat([app('MSI'), Buffer.from('!')]))).toEqual([
      `the two copies of fxm.exe differ in length (${length} and ${length + 1} bytes)`,
    ])
    const elsewhere = app('MSI')
    elsewhere[0] = 0
    expect(appCopyProblems(app('NSS'), elsewhere)).toEqual([
      'the two copies of fxm.exe differ in more than their bundle type',
    ])
    // Two installers' types, but not NSIS's and the MSI's.
    expect(appCopyProblems(app('NSS'), app('DEB'))).toEqual([
      'the two copies of fxm.exe differ in more than their bundle type',
    ])
  })

  it('only the plugins pinned, each with the bytes collected', () => {
    const dir = join(folder, 'to-sign')
    collectAll(dir, { ...PLUGINS, 'Evil.dll': Buffer.from('MZ evil') })
    const problems = collectedProblems(dir, readCollected(dir), PINS)
    expect(problems).toEqual([
      `Evil.dll (${sha256(Buffer.from('MZ evil'))}) is no NSIS plugin that Tauri packs`,
    ])
    const changed = join(folder, 'changed')
    collectAll(changed, { ...PLUGINS, 'System.dll': Buffer.from('MZ System.dll, rebuilt') })
    expect(collectedProblems(changed, readCollected(changed), PINS)).toEqual([
      `System.dll has SHA-256 ${sha256(Buffer.from('MZ System.dll, rebuilt'))}, not ` +
        `${PINS['System.dll']}: check it against the Tauri CLI's sources before trusting it ` +
        '(PINNED_PLUGINS)',
    ])
    const missing = join(folder, 'missing')
    collectAll(missing, { 'System.dll': PLUGINS['System.dll'] })
    expect(collectedProblems(missing, readCollected(missing), PINS)).toEqual([
      "nsDialogs.dll wasn't collected",
    ])
  })

  it('refuses files swapped after the build collected them', () => {
    const dir = join(folder, 'to-sign')
    collectAll(dir)
    const plugin = readCollected(dir).find((file) => file.name === 'System.dll')
    if (plugin === undefined) throw new Error('no System.dll')
    writeFileSync(join(dir, keptName(plugin)), 'MZ something else')
    expect(collectedProblems(dir, readCollected(dir), PINS)).toEqual([
      'System.dll: not the bytes collected',
    ])
  })

  it('pins the five plugins Tauri’s bundler signs, by SHA-256', () => {
    expect(Object.keys(PINNED_PLUGINS).sort()).toEqual([
      'NSISdl.dll',
      'StartMenu.dll',
      'System.dll',
      'nsDialogs.dll',
      'nsis_tauri_utils.dll',
    ])
    for (const hash of Object.values(PINNED_PLUGINS)) expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('signtool', () => {
  it('signs with SHA-256 digests, the certificate by thumbprint and an RFC 3161 timestamp', () => {
    expect(signtoolArgs(THUMBPRINT.toLowerCase(), '', ['a.exe', 'b.dll'])).toEqual([
      'sign',
      '/fd',
      'sha256',
      '/sha1',
      THUMBPRINT,
      '/d',
      'FXM',
      '/tr',
      DEFAULT_TIMESTAMP_URL,
      '/td',
      'sha256',
      'a.exe',
      'b.dll',
    ])
    expect(() => signtoolArgs(THUMBPRINT, '', [])).toThrow('nothing to sign')
  })

  it('tries again when a timestamp server doesn’t answer, three times in all', () => {
    const file = tauriFile('a.exe', Buffer.from('MZ'))
    const flaky = fakeSigntool([1, 0])
    const wait = vi.fn()
    signFiles([file], signing(flaky.run, wait))
    expect(flaky.calls).toHaveLength(2)
    expect(wait).toHaveBeenCalledTimes(1)
    const broken = fakeSigntool([1, 1, 1])
    expect(() => signFiles([file], signing(broken.run))).toThrow('signtool failed 3 times (exit 1)')
  })

  it('is the newest Windows SDK’s, or SIGNTOOL', () => {
    expect(findSigntool({ SIGNTOOL: 'C:\\signtool.exe' })).toBe('C:\\signtool.exe')
    const kits = join(folder, 'Windows Kits', '10', 'bin')
    for (const version of ['10.0.22621.0', '10.0.26100.0', '10.0.9999.0']) {
      mkdirSync(join(kits, version, 'x64'), { recursive: true })
      writeFileSync(join(kits, version, 'x64', 'signtool.exe'), '')
    }
    mkdirSync(join(kits, '10.0.27000.0', 'x64'), { recursive: true })
    expect(findSigntool({ 'ProgramFiles(x86)': folder })).toBe(
      join(kits, '10.0.26100.0', 'x64', 'signtool.exe'),
    )
    expect(() => findSigntool({ 'ProgramFiles(x86)': join(folder, 'none') })).toThrow(
      'no signtool.exe',
    )
  })
})

describe('signing the app, then swapping the signed files in', () => {
  it('signs copies of what the build collected, named by their unsigned bytes', () => {
    const dir = join(folder, 'to-sign')
    const out = join(folder, 'signed-app')
    collectAll(dir)
    const signtool = fakeSigntool()
    const files = signApp(dir, out, signing(signtool.run), PINS)
    expect(signtool.calls).toHaveLength(1)
    expect(signtool.calls[0]?.slice(0, 5)).toEqual(['sign', '/fd', 'sha256', '/sha1', THUMBPRINT])
    expect(signtool.calls[0]?.slice(11)).toEqual(files.map((file) => join(out, keptName(file))))
    expect(JSON.parse(readFileSync(join(out, SIGNED_LIST), 'utf8'))).toEqual(files)
    for (const file of files) {
      expect(readFileSync(join(out, keptName(file))).toString('latin1')).toMatch(/ SIGNED$/)
    }
    // The build's files stay as they were.
    expect(collectedProblems(dir, readCollected(dir), PINS)).toEqual([])
  })

  it('signs nothing when the collected files don’t hold, or the folder isn’t empty', () => {
    const dir = join(folder, 'to-sign')
    collectAll(dir, {})
    const signtool = fakeSigntool()
    expect(() => signApp(dir, join(folder, 'out'), signing(signtool.run), PINS)).toThrow(
      "The files to sign don't hold:\nSystem.dll wasn't collected",
    )
    const good = join(folder, 'good')
    collectAll(good)
    const busy = join(folder, 'busy')
    mkdirSync(busy)
    writeFileSync(join(busy, 'x'), '')
    expect(() => signApp(good, busy, signing(signtool.run), PINS)).toThrow('is not empty')
    expect(signtool.run).not.toHaveBeenCalled()
  })

  it('puts each signed file where Tauri packs the same bytes, and leaves the rest', () => {
    const dir = join(folder, 'to-sign')
    const out = join(folder, 'signed-app')
    collectAll(dir)
    signApp(dir, out, signing(fakeSigntool().run), PINS)
    // tauri bundle patches the same fxm.exe again and hands the hook each copy, then the plugins.
    const nsisApp = tauriFile(APP_BINARY, app('NSS'))
    expect(runHook('swap', out, nsisApp)).toBe('fxm.exe: the signed copy put in its place')
    expect(readFileSync(nsisApp).toString('latin1')).toBe(`${app('NSS').toString('latin1')} SIGNED`)
    const uninstaller = tauriFile('nstA1B2.tmp', Buffer.from('MZ uninstaller'))
    expect(runHook('swap', out, uninstaller)).toBe('nstA1B2.tmp: left as it is')
    expect(readFileSync(uninstaller).toString()).toBe('MZ uninstaller')
    expect(swapProblems(out).problems).toEqual([
      expect.stringMatching(/^Tauri never asked to sign System\.dll /),
      expect.stringMatching(/^Tauri never asked to sign nsDialogs\.dll /),
      expect.stringMatching(/^Tauri never asked to sign fxm\.exe /),
    ])
    for (const [name, bytes] of Object.entries(PLUGINS))
      runHook('swap', out, pluginFile(name, bytes))
    runHook('swap', out, tauriFile(APP_BINARY, app('MSI')))
    expect(swapProblems(out)).toEqual({ problems: [], left: ['nstA1B2.tmp'] })
  })
})

describe('signing the installers', () => {
  function installers(dir: string, setup = Buffer.from('MZ setup')) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SETUP), setup)
    writeFileSync(
      join(dir, MSI),
      Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.from(' msi')]),
    )
  }

  it('signs exactly the two installers of the version, in place', () => {
    const dir = join(folder, 'installers')
    installers(dir)
    const signtool = fakeSigntool()
    expect(signInstallers(dir, VERSION, signing(signtool.run))).toEqual([SETUP, MSI])
    expect(signtool.calls[0]?.slice(11)).toEqual([join(dir, SETUP), join(dir, MSI)])
    expect(readFileSync(join(dir, SETUP)).toString()).toBe('MZ setup SIGNED')
  })

  it('refuses other files, a missing one, and a file that isn’t what its name says', () => {
    const extra = join(folder, 'extra')
    installers(extra)
    writeFileSync(join(extra, 'payload.exe'), 'MZ')
    expect(installerProblems(extra, VERSION)).toEqual([
      `${extra} holds ${[MSI, SETUP, 'payload.exe'].sort().join(', ')}, not ${SETUP}, ${MSI}`,
    ])
    expect(installerProblems(join(folder, 'none'), VERSION)).toEqual([
      `${join(folder, 'none')} holds nothing, not ${SETUP}, ${MSI}`,
    ])
    const wrong = join(folder, 'wrong')
    installers(wrong, Buffer.from('PK zip'))
    expect(installerProblems(wrong, VERSION)).toEqual([
      `${SETUP} is not the installer its name says`,
    ])
    const signtool = fakeSigntool()
    expect(() => signInstallers(wrong, VERSION, signing(signtool.run))).toThrow(
      "The installers don't hold",
    )
    expect(signtool.run).not.toHaveBeenCalled()
  })
})

/** The files windows-check reads, signed by `installers` and `app`. */
function report(
  status: string,
  installers: string | null = THUMBPRINT,
  app: string | null = installers,
  timestamped = true,
): FileSignature[] {
  return [
    { file: MSI, role: 'installer', status, signer: installers, timestamped },
    { file: SETUP, role: 'installer', status, signer: installers, timestamped },
    { file: `fxm.exe in ${MSI}`, role: 'app', status, signer: app, timestamped },
    { file: `fxm.exe in ${SETUP}`, role: 'app', status, signer: app, timestamped },
    { file: `System.dll in ${SETUP}`, role: 'plugin', status, signer: app, timestamped },
  ]
}

describe('the signature check', () => {
  const both = { installers: THUMBPRINT, app: THUMBPRINT }

  it('passes a release whose files Windows trusts, all signed by its certificate, timestamped', () => {
    expect(checkWindowsSignatures(report('Valid'), 'certificate', both)).toEqual([])
  })

  it('passes a dry run signed by the throwaway certificate of each signing job', () => {
    const signers = { installers: THUMBPRINT, app: OTHER }
    expect(
      checkWindowsSignatures(report('UnknownError', THUMBPRINT, OTHER), 'throwaway', signers),
    ).toEqual([])
    expect(
      checkWindowsSignatures(report('NotTrusted', THUMBPRINT, OTHER), 'throwaway', signers),
    ).toEqual([])
  })

  it('fails a release whose signatures Windows doesn’t trust, or that two certificates made', () => {
    expect(checkWindowsSignatures(report('UnknownError'), 'certificate', both)).toContain(
      `${MSI}: the signature is UnknownError`,
    )
    expect(
      checkWindowsSignatures(report('Valid', THUMBPRINT, OTHER), 'certificate', {
        installers: THUMBPRINT,
        app: OTHER,
      }),
    ).toEqual([
      `the installers are signed by ${THUMBPRINT}, the app by ${OTHER}: a release's ` +
        'certificate signs both',
    ])
  })

  it('fails files signed by the other job’s certificate, broken, untimestamped or unsigned', () => {
    const signers = { installers: THUMBPRINT, app: OTHER }
    expect(checkWindowsSignatures(report('UnknownError'), 'throwaway', signers)).toEqual([
      `fxm.exe in ${MSI} is signed by ${THUMBPRINT}, not ${OTHER}`,
      `fxm.exe in ${SETUP} is signed by ${THUMBPRINT}, not ${OTHER}`,
      `System.dll in ${SETUP} is signed by ${THUMBPRINT}, not ${OTHER}`,
    ])
    expect(checkWindowsSignatures(report('HashMismatch'), 'throwaway', both)).toContain(
      `${MSI}: the signature is HashMismatch`,
    )
    expect(
      checkWindowsSignatures(report('Valid', THUMBPRINT, THUMBPRINT, false), 'certificate', both),
    ).toContain(`${SETUP} has no timestamp`)
    const unsigned = report('Valid')
    unsigned[4] = {
      ...unsigned[4],
      file: `System.dll in ${SETUP}`,
      role: 'plugin',
      status: 'NotSigned',
      signer: null,
    }
    expect(checkWindowsSignatures(unsigned, 'certificate', both)).toEqual([
      `System.dll in ${SETUP} is not signed`,
    ])
  })

  it('passes an unsigned release only when nothing is signed', () => {
    expect(checkWindowsSignatures(report('NotSigned', null, null, false), 'none')).toEqual([])
    expect(checkWindowsSignatures(report('Valid'), 'none')).toContain(
      `${MSI} is signed (Valid), but nothing should be`,
    )
  })

  it('fails when a file is missing, or there is no thumbprint to check against', () => {
    expect(checkWindowsSignatures([], 'none')).toEqual([
      '0 installers checked, not 2',
      '0 copies of fxm.exe checked, not 2',
      'no NSIS plugins checked',
    ])
    expect(checkWindowsSignatures(report('Valid').slice(0, 4), 'certificate', both)).toEqual([
      'no NSIS plugins checked',
    ])
    expect(() =>
      checkWindowsSignatures(report('Valid'), 'certificate', { app: THUMBPRINT }),
    ).toThrow('not a certificate thumbprint')
  })

  it('reads the report PowerShell writes, one file or several', () => {
    const one = {
      file: SETUP,
      role: 'installer',
      status: 'Valid',
      signer: THUMBPRINT,
      timestamped: true,
    }
    expect(parseSignatureReport(JSON.stringify(one))).toEqual([one])
    expect(
      parseSignatureReport(JSON.stringify([{ ...one, signer: null, timestamped: false }])),
    ).toEqual([{ ...one, signer: null, timestamped: false }])
    expect(() => parseSignatureReport('[{"file": 1}]')).toThrow('not a signature')
    expect(() => parseSignatureReport(JSON.stringify({ ...one, role: 'other' }))).toThrow(
      'not a signature',
    )
  })
})

describe('release.ts’s Windows steps', () => {
  it('say how to sign, and tell a release without a certificate that it is unsigned', () => {
    const dryRun = recorder()
    main(['windows-signing', '--mode', 'dry-run', '--certificate', ''], {}, dryRun.reporter)
    expect(dryRun.lines).toContain('output signing=throwaway')
    const unsigned = recorder()
    main(['windows-signing', '--mode', 'release', '--certificate', ''], {}, unsigned.reporter)
    expect(unsigned.lines).toContain('output signing=none')
    expect(unsigned.lines).toContainEqual(expect.stringMatching(/^notice Windows signing: /))
    const signedRelease = recorder()
    main(
      ['windows-signing', '--mode', 'release', '--certificate', 'yes'],
      {},
      signedRelease.reporter,
    )
    expect(signedRelease.lines).toContain('output signing=certificate')
  })

  it('leave a dry run unsigned when the workflow asks, and refuse anything but yes or empty', () => {
    const unsigned = recorder()
    main(
      ['windows-signing', '--mode', 'dry-run', '--certificate', '', '--unsigned', 'yes'],
      {},
      unsigned.reporter,
    )
    expect(unsigned.lines).toContain('output signing=none')
    expect(unsigned.lines).toContainEqual(
      expect.stringMatching(/^notice Windows signing: This dry run leaves the Windows files/),
    )
    const signed = recorder()
    main(
      ['windows-signing', '--mode', 'dry-run', '--certificate', '', '--unsigned', ''],
      {},
      signed.reporter,
    )
    expect(signed.lines).toContain('output signing=throwaway')
    expect(() =>
      main(['windows-signing', '--mode', 'release', '--unsigned', 'yes'], {}, recorder().reporter),
    ).toThrow('for dry runs')
    // A bare flag, or a value the workflow never passes, is a mistake rather than a no.
    for (const args of [['--certificate'], ['--certificate', 'no'], ['--unsigned', 'true']]) {
      expect(() =>
        main(['windows-signing', '--mode', 'release', ...args], {}, recorder().reporter),
      ).toThrow('must be yes or empty')
    }
  })

  it('write the hook’s config, and run the hook for Tauri', () => {
    const hook = recorder()
    const dir = join(folder, 'to-sign')
    main(
      ['windows-hook-config', '--mode', 'collect', '--dir', dir, '--out', join(folder, 'hook')],
      {},
      hook.reporter,
    )
    expect(hook.lines).toEqual([
      `output config-args=--config ${join(folder, 'hook', 'windows-collect.conf.json')}`,
    ])
    const call = recorder()
    const file = tauriFile(APP_BINARY, app('NSS'))
    main(['windows-hook', '--mode', 'collect', '--dir', dir, '--file', file], {}, call.reporter)
    expect(call.lines).toEqual([
      `info fxm.exe: collected to be signed (app, SHA-256 ${sha256(app('NSS'))})`,
    ])
  })

  it('check what the build collected, with a summary', () => {
    const dir = join(folder, 'to-sign')
    collectAll(dir)
    const checked = recorder()
    // The stand-in plugins aren't the pinned ones.
    expect(() => main(['windows-collected', '--dir', dir], {}, checked.reporter)).toThrow(
      "The files to sign don't hold",
    )
    expect(checked.lines).toContainEqual(
      expect.stringMatching(/^summary ### Windows files to sign/),
    )
  })

  it('sign the installers with signtool, and refuse another phase', () => {
    const dir = join(folder, 'installers')
    mkdirSync(dir)
    writeFileSync(join(dir, SETUP), 'MZ')
    writeFileSync(join(dir, MSI), Buffer.from('d0cf11e0a1b11ae1', 'hex'))
    const signtool = fakeSigntool()
    const { lines, reporter } = recorder()
    const args = ['--dir', dir, '--version', VERSION, '--thumbprint', THUMBPRINT]
    main(['windows-sign', '--phase', 'installers', ...args], {}, reporter, {
      signtool: signtool.run,
    })
    expect(lines).toEqual([`info Signed ${SETUP}, ${MSI}`])
    expect(signtool.calls[0]).toContain(DEFAULT_TIMESTAMP_URL)
    expect(() =>
      main(['windows-sign', '--phase', 'all', ...args], {}, reporter, { signtool: signtool.run }),
    ).toThrow('--phase must be app or installers')
  })

  it('check that every signed file went into the installers', () => {
    const dir = join(folder, 'to-sign')
    const out = join(folder, 'signed-app')
    collectAll(dir)
    signApp(dir, out, signing(fakeSigntool().run), PINS)
    expect(() => main(['windows-swapped', '--dir', out], {}, recorder().reporter)).toThrow(
      'Tauri never asked to sign',
    )
    for (const [name, bytes] of Object.entries(PLUGINS))
      runHook('swap', out, pluginFile(name, bytes))
    for (const type of ['NSS', 'MSI']) runHook('swap', out, tauriFile(APP_BINARY, app(type)))
    runHook('swap', out, tauriFile('nstA1B2.tmp', Buffer.from('MZ')))
    const { lines, reporter } = recorder()
    main(['windows-swapped', '--dir', out], {}, reporter)
    expect(lines).toEqual([
      'info Windows: every signed file went into the installers; left as built: nstA1B2.tmp',
    ])
  })

  it('check the signatures, with a summary, and fail on a problem', () => {
    const path = join(folder, 'signatures.json')
    writeFileSync(path, JSON.stringify(report('UnknownError', THUMBPRINT, OTHER)))
    const args = ['--thumbprint', THUMBPRINT, '--app-thumbprint', OTHER, '--report', path]
    const passing = recorder()
    main(['windows-signatures', '--signing', 'throwaway', ...args], {}, passing.reporter)
    expect(passing.lines).toContainEqual(expect.stringMatching(/^summary ### Windows signatures/))
    expect(passing.lines).toContain('info Windows signatures: 5 files, as expected (throwaway)')
    expect(() =>
      main(['windows-signatures', '--signing', 'certificate', ...args], {}, recorder().reporter),
    ).toThrow("The Windows signatures don't hold")
  })
})
