/**
 * Test helpers for the release scripts: the Tauri CLI's signer, from node_modules, which needs no
 * project and no network. The tests make every key pair they use in a temporary folder.
 *
 * @module
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TAURI = fileURLToPath(new URL('../node_modules/.bin/tauri', import.meta.url))

/** Runs the Tauri CLI and returns what it printed. */
export function tauri(args: readonly string[]): string {
  return execFileSync(TAURI, args, {
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** A new temporary folder. */
export function temporaryFolder(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `fxm-${prefix}-`))
}

/** A key pair that `tauri signer generate` made in `folder`, encrypted with `password`. */
export function cliKeyPair(folder: string, password: string) {
  const path = join(folder, 'test.key')
  tauri(['signer', 'generate', '--ci', '-p', password, '-w', path])
  return {
    path,
    secretKey: readFileSync(path, 'utf8'),
    publicKey: readFileSync(`${path}.pub`, 'utf8'),
  }
}

/** Signs `file` with the Tauri CLI, as `tauri build` signs an updater file, and returns the signature. */
export function cliSign(keyPath: string, password: string, file: string, version: string): string {
  tauri(['signer', 'sign', '-f', keyPath, '-p', password, '--app-version', version, file])
  return readFileSync(`${file}.sig`, 'utf8')
}
