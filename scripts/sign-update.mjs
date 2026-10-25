/**
 * FXM's signing tool for the updates that the desktop and Android apps download (stage 1.13).
 * The owner runs it through the scripts, never by hand:
 *
 *   scripts/make-signing-key.sh <folder outside the repository>   once: the Ed25519 key pair
 *   scripts/sign-config.sh --key <private key file>               after changing the config
 *   scripts/sign-module.sh --key <private key file>               after changing the YouTube code
 *
 * It signs locally (or in an approval-gated CI environment, with --key-env), so the key never
 * reaches the deploy job. Node runs it with type stripping, so it uses the same TypeScript as
 * the apps: @fxm/platform's signing and verification, and the YouTube module's build.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { toBase64 } from '../packages/platform/src/updates/encoding.ts'
import { parseEnvelope, parseStatement } from '../packages/platform/src/updates/format.ts'
import {
  generateSigningKey,
  importSigningKey,
  pemToPkcs8,
  pkcs8ToPem,
  signUpdate,
} from '../packages/platform/src/updates/sign.ts'
import {
  checkArtifactBytes,
  createSignatureVerifier,
  verifySignatureFile,
} from '../packages/platform/src/updates/verify.ts'
import { buildYouTubeModule } from '../packages/sources/src/youtube/module/build.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEYS_FILE = join(REPO, 'packages/platform/src/updates/update-keys.json')
const CONFIG_FILE = join(REPO, 'packages/sources/src/youtube/youtube-config.json')
const DEFAULT_OUT = join(REPO, 'apps/site/public/updates')
const PRIVATE_KEY_FILE = 'fxm-update-signing-key.pem'
const PUBLIC_KEY_FILE = 'fxm-update-signing-key.pub.json'

class UsageError extends Error {}

function fail(message) {
  throw new UsageError(message)
}

/** Whether `path` is inside `folder` (or is it). */
function inside(folder, path) {
  const rel = relative(folder, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The FXM checkouts a key must stay out of: this one and the main one that owns `.tools`. */
function checkouts() {
  return [REPO, process.env.FXM_HOME, process.env.FXM_ROOT]
    .filter(Boolean)
    .map((path) => resolve(path))
}

function refuseInsideRepo(path, what) {
  for (const checkout of checkouts()) {
    if (inside(checkout, path)) {
      fail(`${what} must stay outside the repository (${checkout}), so it can never be committed.`)
    }
  }
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

// --- keygen ------------------------------------------------------------------------------------

async function keygen(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} })
  if (positionals.length !== 1)
    fail('Usage: scripts/make-signing-key.sh <folder outside the repository>')
  const folder = resolve(positionals[0])
  refuseInsideRepo(folder, 'The signing key')
  const privatePath = join(folder, PRIVATE_KEY_FILE)
  const publicPath = join(folder, PUBLIC_KEY_FILE)
  for (const path of [privatePath, publicPath]) {
    if (await exists(path)) fail(`${path} already exists: a key pair is never overwritten.`)
  }
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const key = await generateSigningKey()
  const entry = { id: key.keyId, publicKey: toBase64(key.publicKey) }
  await writeFile(privatePath, pkcs8ToPem(key.pkcs8), { mode: 0o600, flag: 'wx' })
  await writeFile(publicPath, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o644, flag: 'wx' })
  console.log(`Created the FXM update signing key ${key.keyId}:

  private key  ${privatePath}  (secret: back it up offline, never commit or share it)
  public key   ${publicPath}

Next, trust it in every build: in packages/platform/src/updates/update-keys.json, replace the
placeholder entry with this one, and commit that file:

${JSON.stringify(entry, null, 2)}

Then sign with: scripts/sign-config.sh --key ${privatePath}
           and: scripts/sign-module.sh --key ${privatePath}`)
}

// --- sign --------------------------------------------------------------------------------------

async function loadKey(values) {
  let pem
  if (values.key !== undefined && values['key-env'] !== undefined)
    fail('Give --key or --key-env, not both.')
  if (values.key !== undefined) {
    const path = resolve(values.key)
    refuseInsideRepo(path, 'The private key')
    pem = await readFile(path, 'utf8').catch(() => fail(`Can't read the private key ${path}`))
    const { mode } = await stat(path)
    if ((mode & 0o077) !== 0) {
      console.warn(`! ${path} can be read by other users: run chmod 600 on it.`)
    }
  } else if (values['key-env'] !== undefined) {
    pem = process.env[values['key-env']]
    if (!pem) fail(`The environment variable ${values['key-env']} holds no private key.`)
  } else {
    fail('Give the private key: --key <file> (or --key-env <variable> in CI).')
  }
  try {
    return await importSigningKey(pemToPkcs8(pem))
  } catch {
    return fail('That is not an Ed25519 private key in PEM (-----BEGIN PRIVATE KEY-----).')
  }
}

/** The entry of `update-keys.json` for this key, so apps accept what it signs. */
async function trustedEntry(key, allowUntrusted) {
  const file = JSON.parse(await readFile(KEYS_FILE, 'utf8'))
  const publicKey = toBase64(key.publicKey)
  const listed = (file.keys ?? []).some(
    (entry) => entry.id === key.keyId && entry.publicKey === publicKey,
  )
  if (!listed && !allowUntrusted) {
    fail(
      `The key ${key.keyId} is not in packages/platform/src/updates/update-keys.json, so apps would ` +
        'refuse what it signs. Add its public key there first (scripts/make-signing-key.sh printed the entry).',
    )
  }
  return { id: key.keyId, publicKey: key.publicKey }
}

/** What to sign: the config file as it is, or the freshly built module. */
async function artifact(what) {
  if (what === 'config') {
    const bytes = new Uint8Array(await readFile(CONFIG_FILE))
    const { revision } = JSON.parse(new TextDecoder().decode(bytes))
    if (!Number.isSafeInteger(revision) || revision < 1)
      fail('youtube-config.json has no valid revision.')
    return {
      kind: 'youtube-config',
      file: 'youtube-config.json',
      version: revision,
      bytes,
      maxBytes: 256 * 1024,
    }
  }
  if (what === 'module') {
    const built = await buildYouTubeModule()
    return {
      kind: 'youtube-module',
      file: built.fileName,
      version: built.version,
      api: built.api,
      bytes: built.bytes,
      maxBytes: 8 * 1024 * 1024,
    }
  }
  return fail('Sign what? config or module.')
}

/** The version already in the output folder, if any, which the new one must exceed. */
async function publishedVersion(out, file) {
  try {
    const envelope = parseEnvelope(new Uint8Array(await readFile(join(out, `${file}.sig`))))
    return parseStatement(envelope.statementBytes).version
  } catch {
    return undefined
  }
}

async function sign(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      key: { type: 'string' },
      'key-env': { type: 'string' },
      out: { type: 'string' },
      'allow-untrusted-key': { type: 'boolean' },
    },
  })
  const what = positionals[0]
  const out = resolve(values.out ?? DEFAULT_OUT)
  const key = await loadKey(values)
  const trusted = await trustedEntry(key, values['allow-untrusted-key'] === true)
  const update = await artifact(what)
  const published = await publishedVersion(out, update.file)
  if (published !== undefined && published >= update.version) {
    fail(
      `${update.file} version ${published} is already in ${out}. Apps take only higher versions: ` +
        (what === 'config'
          ? 'raise "revision" in youtube-config.json first.'
          : 'raise YOUTUBE_MODULE_VERSION in packages/sources/src/youtube/module/version.ts first.'),
    )
  }
  const signed = await signUpdate(key, {
    kind: update.kind,
    version: update.version,
    file: update.file,
    bytes: update.bytes,
    ...(update.api === undefined ? {} : { api: update.api }),
  })
  // Check the result exactly as the apps will, before anything is written.
  const expectation = {
    kind: update.kind,
    file: update.file,
    maxBytes: update.maxBytes,
    ...(update.api === undefined ? {} : { api: update.api }),
  }
  const verdict = await verifySignatureFile(
    signed.envelope,
    expectation,
    [trusted],
    createSignatureVerifier(),
  )
  if (!verdict.ok || checkArtifactBytes(update.bytes, verdict.statement) !== undefined) {
    fail('The new signature does not verify: nothing was written.')
  }
  await mkdir(out, { recursive: true })
  await writeFile(join(out, update.file), update.bytes)
  await writeFile(join(out, `${update.file}.sig`), signed.envelope)
  const { statement } = signed
  console.log(`Signed ${statement.kind} version ${statement.version} with ${key.keyId}:

  ${join(out, update.file)}  (${statement.size} bytes, SHA-256 ${statement.sha256})
  ${join(out, `${update.file}.sig`)}

Commit both files and deploy the site: the desktop and Android apps pick them up on their next
start. Publish both files together, and never edit the signed file afterwards.`)
}

// --- main --------------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2)
try {
  if (command === 'keygen') await keygen(rest)
  else if (command === 'sign') await sign(rest)
  else
    fail(
      'Usage: sign-update.mjs keygen <folder> | sign config|module --key <file> [--out <folder>]',
    )
} catch (error) {
  if (!(error instanceof UsageError)) throw error
  console.error(`✘ ${error.message}`)
  process.exitCode = 1
}
