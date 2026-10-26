import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Reporter } from './actions.ts'
import { main } from './release.ts'
import { temporaryFolder } from './testing.ts'
import {
  checkWindowsSignatures,
  chooseWindowsSigning,
  DEFAULT_TIMESTAMP_URL,
  type FileSignature,
  parseSignatureReport,
  parseThumbprint,
  parseTimestampUrl,
  parseWindowsSigning,
  windowsSigningConfig,
  writeWindowsSigningConfig,
} from './windows-signing.ts'

const THUMBPRINT = '0123456789ABCDEF0123456789ABCDEF01234567'
const OTHER = 'FEDCBA9876543210FEDCBA9876543210FEDCBA98'

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

let folder: string
beforeEach(() => {
  folder = temporaryFolder('windows-signing')
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

/** The three Windows files the build job checks. */
const signed = (
  status: string,
  signer: string | null = THUMBPRINT,
  timestamped = true,
): FileSignature[] =>
  ['fxm.exe', 'fxm-desktop-0.7.0-windows-x64-setup.exe', 'fxm-desktop-0.7.0-windows-x64.msi'].map(
    (file) => ({ file, status, signer, timestamped }),
  )

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

  it('reads --signing', () => {
    expect(parseWindowsSigning('certificate')).toBe('certificate')
    expect(() => parseWindowsSigning('signpath')).toThrow('--signing must be')
  })
})

describe('the Tauri config that signs', () => {
  it('names the certificate by thumbprint, with SHA-256 and an RFC 3161 timestamp', () => {
    expect(windowsSigningConfig(THUMBPRINT.toLowerCase(), '')).toEqual({
      bundle: {
        windows: {
          certificateThumbprint: THUMBPRINT,
          digestAlgorithm: 'sha256',
          timestampUrl: DEFAULT_TIMESTAMP_URL,
          tsp: true,
        },
      },
    })
    expect(
      windowsSigningConfig(THUMBPRINT, 'http://timestamp.digicert.com').bundle.windows.timestampUrl,
    ).toBe('http://timestamp.digicert.com')
  })

  it('refuses what isn’t a thumbprint or a timestamp server', () => {
    expect(parseThumbprint(` ${THUMBPRINT.toLowerCase()} `)).toBe(THUMBPRINT)
    for (const value of ['', '0123', `${THUMBPRINT}00`, 'G'.repeat(40), `"${THUMBPRINT}"`]) {
      expect(() => parseThumbprint(value), value).toThrow('not a certificate thumbprint')
    }
    expect(parseTimestampUrl('')).toBe(DEFAULT_TIMESTAMP_URL)
    for (const value of ['time.certum.pl', 'ftp://time.certum.pl', 'file:///etc/passwd']) {
      expect(() => parseTimestampUrl(value), value).toThrow('timestamp server')
    }
  })

  it('is written for tauri build --config, and holds no secret', () => {
    const args = writeWindowsSigningConfig(folder, THUMBPRINT, '')
    const path = join(folder, 'windows-signing.conf.json')
    expect(args).toBe(`--config ${path}`)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(windowsSigningConfig(THUMBPRINT, ''))
  })
})

describe('the signature check', () => {
  it('passes a release whose files Windows trusts, signed by its certificate, timestamped', () => {
    expect(checkWindowsSignatures(signed('Valid'), 'certificate', THUMBPRINT)).toEqual([])
  })

  it('passes a dry run signed by its throwaway certificate, whose root nothing trusts', () => {
    expect(checkWindowsSignatures(signed('UnknownError'), 'throwaway', THUMBPRINT)).toEqual([])
    expect(checkWindowsSignatures(signed('NotTrusted'), 'throwaway', THUMBPRINT)).toEqual([])
  })

  it('fails a release whose signature Windows doesn’t trust', () => {
    expect(checkWindowsSignatures(signed('UnknownError'), 'certificate', THUMBPRINT)).toContain(
      'fxm.exe: the signature is UnknownError',
    )
  })

  it('fails files signed by another certificate, broken, untimestamped or not signed', () => {
    expect(checkWindowsSignatures(signed('Valid', OTHER), 'certificate', THUMBPRINT)).toContain(
      `fxm.exe is signed by ${OTHER}, not ${THUMBPRINT}`,
    )
    expect(checkWindowsSignatures(signed('HashMismatch'), 'throwaway', THUMBPRINT)).toContain(
      'fxm.exe: the signature is HashMismatch',
    )
    expect(
      checkWindowsSignatures(signed('Valid', THUMBPRINT, false), 'certificate', THUMBPRINT),
    ).toContain('fxm.exe has no timestamp')
    expect(checkWindowsSignatures(signed('NotSigned', null), 'throwaway', THUMBPRINT)).toEqual([
      'fxm.exe is not signed',
      'fxm-desktop-0.7.0-windows-x64-setup.exe is not signed',
      'fxm-desktop-0.7.0-windows-x64.msi is not signed',
    ])
  })

  it('passes an unsigned release only when nothing is signed', () => {
    expect(checkWindowsSignatures(signed('NotSigned', null, false), 'none')).toEqual([])
    expect(checkWindowsSignatures(signed('Valid'), 'none')).toContain(
      'fxm.exe is signed (Valid), but nothing should be',
    )
  })

  it('fails when there is nothing to check, or no thumbprint to check against', () => {
    expect(checkWindowsSignatures([], 'none')).toEqual(['no Windows files were checked'])
    expect(() => checkWindowsSignatures(signed('Valid'), 'certificate')).toThrow(
      'not a certificate thumbprint',
    )
  })

  it('reads the report PowerShell writes, one file or several', () => {
    const one = { file: 'fxm.exe', status: 'Valid', signer: THUMBPRINT, timestamped: true }
    expect(parseSignatureReport(JSON.stringify(one))).toEqual([one])
    expect(
      parseSignatureReport(JSON.stringify([{ ...one, signer: null, timestamped: false }])),
    ).toEqual([{ ...one, signer: null, timestamped: false }])
    expect(() => parseSignatureReport('[{"file": 1}]')).toThrow('not a signature')
  })
})

describe('release.ts windows-signing, windows-signing-config and windows-signatures', () => {
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

  it('write the config for the certificate’s thumbprint', () => {
    const { lines, reporter } = recorder()
    main(
      [
        'windows-signing-config',
        '--thumbprint',
        THUMBPRINT,
        '--timestamp-url',
        '',
        '--out',
        folder,
      ],
      {},
      reporter,
    )
    expect(lines).toEqual([
      `output config-args=--config ${join(folder, 'windows-signing.conf.json')}`,
    ])
  })

  it('check the signatures, with a summary, and fail on a problem', () => {
    const report = join(folder, 'signatures.json')
    writeFileSync(report, JSON.stringify(signed('UnknownError')))
    const passing = recorder()
    main(
      [
        'windows-signatures',
        '--signing',
        'throwaway',
        '--thumbprint',
        THUMBPRINT,
        '--report',
        report,
      ],
      {},
      passing.reporter,
    )
    expect(passing.lines).toContainEqual(expect.stringMatching(/^summary ### Windows signatures/))
    expect(() =>
      main(
        [
          'windows-signatures',
          '--signing',
          'certificate',
          '--thumbprint',
          THUMBPRINT,
          '--report',
          report,
        ],
        {},
        recorder().reporter,
      ),
    ).toThrow("The Windows signatures don't hold")
  })
})
