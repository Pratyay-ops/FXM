/**
 * Windows code signing in the release workflow (stage 7.6, docs/CODE-SIGNING.md). The Windows
 * build job of `.github/workflows/desktop-release.yml` signs with a certificate in the runner's
 * certificate store, through Tauri's own signing (`bundle > windows > certificateThumbprint`),
 * which signs everything it builds before it packs it: `fxm.exe`, the NSIS installer and its
 * uninstaller, and the MSI. Which certificate:
 *
 * - a dry run: a throwaway self-signed one, made on the runner, so every dry run tries the
 *   signing and its checks; nothing trusts it;
 * - a release: the certificate in the `windows-signing` environment's secrets
 *   (`WINDOWS_CERTIFICATE`, a base64 PKCS #12 file, and `WINDOWS_CERTIFICATE_PASSWORD`), when it
 *   has one;
 * - otherwise none: the release goes on unsigned, and says so.
 *
 * PowerShell makes or imports the certificate and reads the signatures (`Get-AuthenticodeSignature`);
 * the decisions and checks are here, with tests.
 *
 * @module
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Mode } from './release.ts'

/** How the Windows build is signed: see the module documentation. */
export type WindowsSigning = 'throwaway' | 'certificate' | 'none'

/**
 * The timestamp server when the repository sets none (`vars.WINDOWS_TIMESTAMP_URL`): Certum's,
 * which speaks RFC 3161, as FXM's paid fallback certificate would come from Certum. A timestamp
 * keeps a signature valid after the certificate expires.
 */
export const DEFAULT_TIMESTAMP_URL = 'http://time.certum.pl'

/** The subject of a dry run's throwaway certificate. */
export const THROWAWAY_SUBJECT = 'CN=FXM release dry run (throwaway, untrusted)'

/** The signing from `--signing`. */
export function parseWindowsSigning(value: string): WindowsSigning {
  if (value === 'throwaway' || value === 'certificate' || value === 'none') return value
  throw new Error(`--signing must be throwaway, certificate or none, got "${value}"`)
}

/** How to sign: a dry run always signs, a release when the environment holds a certificate. */
export function chooseWindowsSigning(mode: Mode, hasCertificate: boolean): WindowsSigning {
  if (mode === 'dry-run') return 'throwaway'
  return hasCertificate ? 'certificate' : 'none'
}

/** A certificate's SHA-1 thumbprint, as signtool takes it: 40 hexadecimal digits. */
export function parseThumbprint(value: string): string {
  const thumbprint = value.trim().toUpperCase()
  if (!/^[0-9A-F]{40}$/.test(thumbprint)) {
    throw new Error(`"${value}" is not a certificate thumbprint (40 hexadecimal digits)`)
  }
  return thumbprint
}

/** A timestamp server's address: an http or https URL, which signtool takes with `/tr`. */
export function parseTimestampUrl(value: string): string {
  const url = value.trim() === '' ? DEFAULT_TIMESTAMP_URL : value.trim()
  if (!URL.canParse(url) || !['http:', 'https:'].includes(new URL(url).protocol)) {
    throw new Error(`"${value}" is not an http or https URL of a timestamp server`)
  }
  return url
}

/**
 * The Tauri configuration that turns signing on: the certificate's thumbprint, SHA-256 digests
 * and an RFC 3161 timestamp (`tsp`).
 */
export function windowsSigningConfig(thumbprint: string, timestampUrl: string) {
  return {
    bundle: {
      windows: {
        certificateThumbprint: parseThumbprint(thumbprint),
        digestAlgorithm: 'sha256',
        timestampUrl: parseTimestampUrl(timestampUrl),
        tsp: true,
      },
    },
  }
}

/** Writes {@link windowsSigningConfig} for `tauri build --config`, and returns the argument. */
export function writeWindowsSigningConfig(out: string, thumbprint: string, timestampUrl: string) {
  mkdirSync(out, { recursive: true })
  const path = join(resolve(out), 'windows-signing.conf.json')
  writeFileSync(path, `${JSON.stringify(windowsSigningConfig(thumbprint, timestampUrl))}\n`)
  return `--config ${path}`
}

/** One file's signature, as `Get-AuthenticodeSignature` reports it. */
export interface FileSignature {
  /** The file's name. */
  readonly file: string
  /** `Valid`, `NotSigned`, `UnknownError` (an untrusted root, for one), `HashMismatch`, … */
  readonly status: string
  /** The signing certificate's thumbprint, if the file is signed. */
  readonly signer?: string | null
  /** Whether the signature carries a timestamp. */
  readonly timestamped?: boolean
}

/**
 * What is wrong with the signatures of the Windows files, given how they were signed: nothing
 * signed for `none`; for the others, every file signed by that certificate, with a timestamp, and
 * for a release's certificate a signature Windows trusts (`Valid`). A throwaway certificate's
 * root is untrusted (`UnknownError`, or `NotTrusted`), but its signature must still match the
 * file.
 */
export function checkWindowsSignatures(
  signatures: readonly FileSignature[],
  signing: WindowsSigning,
  thumbprint?: string,
): string[] {
  if (signatures.length === 0) return ['no Windows files were checked']
  const problems: string[] = []
  const expected = signing === 'none' ? undefined : parseThumbprint(thumbprint ?? '')
  for (const signature of signatures) {
    const { file, status } = signature
    if (signing === 'none') {
      if (status !== 'NotSigned')
        problems.push(`${file} is signed (${status}), but nothing should be`)
      continue
    }
    if (status === 'NotSigned') {
      problems.push(`${file} is not signed`)
      continue
    }
    const trusted = signing === 'certificate' ? ['Valid'] : ['Valid', 'UnknownError', 'NotTrusted']
    if (!trusted.includes(status)) problems.push(`${file}: the signature is ${status}`)
    if (signature.signer?.toUpperCase() !== expected) {
      problems.push(`${file} is signed by ${signature.signer ?? 'nobody'}, not ${expected}`)
    }
    if (signature.timestamped !== true) problems.push(`${file} has no timestamp`)
  }
  return problems
}

/** Reads the report the workflow's PowerShell writes: one object, or an array of them. */
export function parseSignatureReport(json: string): FileSignature[] {
  const parsed: unknown = JSON.parse(json)
  const items = Array.isArray(parsed) ? parsed : [parsed]
  return items.map((item) => {
    const entry = item as Record<string, unknown>
    if (typeof entry.file !== 'string' || typeof entry.status !== 'string') {
      throw new Error(`not a signature: ${JSON.stringify(item)}`)
    }
    return {
      file: entry.file,
      status: entry.status,
      signer: typeof entry.signer === 'string' ? entry.signer : null,
      timestamped: entry.timestamped === true,
    }
  })
}
