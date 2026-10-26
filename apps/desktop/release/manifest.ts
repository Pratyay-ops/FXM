/**
 * `latest.json`, the updater's manifest: the newest version, and for each platform the address of
 * its file and the file's signature. The desktop app reads it from the latest release on GitHub
 * (`plugins > updater > endpoints` in `tauri.conf.json`), in tauri-plugin-updater's static format.
 *
 * @module
 */
import { type PublicKey, signedVersion, verify } from './minisign.ts'
import { releaseFiles } from './targets.ts'

/** A platform's entry. */
export interface ManifestPlatform {
  readonly signature: string
  readonly url: string
}

/** The manifest, as tauri-plugin-updater reads it. */
export interface Manifest {
  readonly version: string
  readonly notes: string
  /** RFC 3339. */
  readonly pub_date: string
  readonly platforms: Readonly<Record<string, ManifestPlatform>>
}

/** Where a release's file is downloaded from. */
export function downloadUrl(repo: string, version: string, file: string): string {
  return `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(file)}`
}

/** The release's page, with its notes. */
export function releasePage(repo: string, version: string): string {
  return `https://github.com/${repo}/releases/tag/v${version}`
}

export interface ManifestOptions {
  readonly version: string
  /** The repository, `owner/name`. */
  readonly repo: string
  readonly published: Date
  /** The signature of each file the updater installs, by its name in the release. */
  readonly signatures: ReadonlyMap<string, string>
}

/** The manifest of a release. Throws when a file the updater installs has no signature. */
export function buildManifest({ version, repo, published, signatures }: ManifestOptions): Manifest {
  const platforms: Record<string, ManifestPlatform> = {}
  for (const file of releaseFiles(version)) {
    if (file.platforms.length === 0) continue
    const signature = signatures.get(file.name)
    if (signature === undefined) throw new Error(`${file.name} has no signature`)
    for (const platform of file.platforms) {
      platforms[platform] = { signature, url: downloadUrl(repo, version, file.name) }
    }
  }
  return {
    version,
    notes: `FXM ${version}. What changed: ${releasePage(repo, version)}`,
    pub_date: published.toISOString(),
    platforms,
  }
}

export interface ManifestCheck {
  readonly version: string
  readonly repo: string
  /** The key the release's apps carry. */
  readonly publicKey: PublicKey
  /** A release file's bytes, or `undefined` when the release lacks it. */
  read(name: string): Uint8Array | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * What is wrong with a manifest, as each platform's updater would find it: the version, the date,
 * exactly the expected platforms, each pointing at its own file of this release, with a signature
 * that holds under the apps' key and names this version. Empty when nothing is.
 */
export function checkManifest(manifest: unknown, check: ManifestCheck): string[] {
  const problems: string[] = []
  if (!isRecord(manifest)) return ['latest.json is not a JSON object']
  if (manifest.version !== check.version) {
    problems.push(`latest.json announces ${String(manifest.version)}, not ${check.version}`)
  }
  const published = manifest.pub_date
  if (typeof published !== 'string' || Number.isNaN(Date.parse(published))) {
    problems.push('latest.json has no publication date')
  }
  const platforms = isRecord(manifest.platforms) ? manifest.platforms : {}
  const expected = new Map<string, string>()
  for (const file of releaseFiles(check.version)) {
    for (const platform of file.platforms) expected.set(platform, file.name)
  }
  for (const platform of Object.keys(platforms)) {
    if (!expected.has(platform)) problems.push(`latest.json lists an unknown platform ${platform}`)
  }
  for (const [platform, file] of expected) {
    const entry = platforms[platform]
    if (!isRecord(entry)) {
      problems.push(`latest.json has no ${platform}`)
      continue
    }
    if (entry.url !== downloadUrl(check.repo, check.version, file)) {
      problems.push(
        `${platform} points at ${String(entry.url)}, not at ${file} of v${check.version}`,
      )
    }
    const bytes = check.read(file)
    if (bytes === undefined) {
      problems.push(`${platform}: the release has no ${file}`)
      continue
    }
    if (typeof entry.signature !== 'string') {
      problems.push(`${platform} has no signature`)
      continue
    }
    try {
      const signed = signedVersion(verify(bytes, entry.signature, check.publicKey))
      if (signed !== check.version) {
        problems.push(`${platform}: ${file} is signed for version ${signed ?? 'none'}`)
      }
    } catch (error) {
      problems.push(`${platform}: ${(error as Error).message}`)
    }
  }
  return problems
}
