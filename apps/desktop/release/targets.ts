/**
 * What a release builds for the desktop app: five targets, the files each one publishes, and which
 * of them the updater installs (`latest.json`). `.github/workflows/desktop-release.yml` builds one
 * target per job, and its matrix must list the same targets (test/release-workflow.test.ts).
 *
 * File names follow the release's own (`fxm-<what>-<version>…`, docs/WORKFLOW.md, "Releases"):
 * `fxm-desktop-<version>-<os>-<cpu>`, with `x64` and `arm64` everywhere, whatever the bundle
 * format calls them. The sources are where the Tauri bundler writes each file under
 * `target/<triple>/release/bundle/`.
 *
 * @module
 */

/** A release target, as the workflow's matrix names it. */
export type TargetId = 'macos-arm64' | 'macos-x64' | 'windows-x64' | 'linux-x64' | 'linux-arm64'

/** A file that a target's build publishes. */
export interface ReleaseFile {
  /** Where the bundler writes it, under the bundle folder. */
  readonly source: string
  /** Its name in the release. */
  readonly name: string
  /**
   * The keys of `latest.json`'s `platforms` that point at it, if the updater installs it.
   * tauri-plugin-updater looks up `<os>-<arch>-<installer>` first, then `<os>-<arch>`, where
   * `<installer>` is the bundle the running app came from (`app`, `nsis`, `msi`, `appimage`,
   * `deb`), so every bundle gets its own key: an app installed from the `.msi` must never be
   * handed the NSIS installer, nor a `.deb` installation the AppImage.
   */
  readonly platforms: readonly string[]
}

/** A release target. */
export interface ReleaseTarget {
  readonly id: TargetId
  /** The Rust target triple, given to `tauri build --target`. */
  readonly triple: string
  /** The bundles to build, given to `tauri build --bundles`. */
  readonly bundles: string
  /** The files it publishes, for a version. */
  files(version: string): readonly ReleaseFile[]
}

const name = (version: string, target: TargetId, suffix: string) =>
  `fxm-desktop-${version}-${target}${suffix}`

/** The release targets, in the order the release lists them. */
export const TARGETS: readonly ReleaseTarget[] = [
  {
    id: 'macos-arm64',
    triple: 'aarch64-apple-darwin',
    bundles: 'app,dmg',
    files: (version) => [
      {
        source: `dmg/FXM_${version}_aarch64.dmg`,
        name: name(version, 'macos-arm64', '.dmg'),
        platforms: [],
      },
      {
        source: 'macos/FXM.app.tar.gz',
        name: name(version, 'macos-arm64', '.app.tar.gz'),
        platforms: ['darwin-aarch64-app', 'darwin-aarch64'],
      },
    ],
  },
  {
    id: 'macos-x64',
    triple: 'x86_64-apple-darwin',
    bundles: 'app,dmg',
    files: (version) => [
      {
        source: `dmg/FXM_${version}_x64.dmg`,
        name: name(version, 'macos-x64', '.dmg'),
        platforms: [],
      },
      {
        source: 'macos/FXM.app.tar.gz',
        name: name(version, 'macos-x64', '.app.tar.gz'),
        platforms: ['darwin-x86_64-app', 'darwin-x86_64'],
      },
    ],
  },
  {
    id: 'windows-x64',
    triple: 'x86_64-pc-windows-msvc',
    bundles: 'nsis,msi',
    files: (version) => [
      {
        source: `nsis/FXM_${version}_x64-setup.exe`,
        name: name(version, 'windows-x64', '-setup.exe'),
        platforms: ['windows-x86_64-nsis', 'windows-x86_64'],
      },
      {
        source: `msi/FXM_${version}_x64_en-US.msi`,
        name: name(version, 'windows-x64', '.msi'),
        platforms: ['windows-x86_64-msi'],
      },
    ],
  },
  {
    id: 'linux-x64',
    triple: 'x86_64-unknown-linux-gnu',
    bundles: 'deb,appimage',
    files: (version) => [
      {
        source: `appimage/FXM_${version}_amd64.AppImage`,
        name: name(version, 'linux-x64', '.AppImage'),
        platforms: ['linux-x86_64-appimage', 'linux-x86_64'],
      },
      {
        source: `deb/FXM_${version}_amd64.deb`,
        name: name(version, 'linux-x64', '.deb'),
        platforms: ['linux-x86_64-deb'],
      },
    ],
  },
  {
    id: 'linux-arm64',
    triple: 'aarch64-unknown-linux-gnu',
    bundles: 'deb,appimage',
    files: (version) => [
      {
        source: `appimage/FXM_${version}_aarch64.AppImage`,
        name: name(version, 'linux-arm64', '.AppImage'),
        platforms: ['linux-aarch64-appimage', 'linux-aarch64'],
      },
      {
        source: `deb/FXM_${version}_arm64.deb`,
        name: name(version, 'linux-arm64', '.deb'),
        platforms: ['linux-aarch64-deb'],
      },
    ],
  },
]

/** The target with this id. Throws on an unknown one. */
export function targetById(id: string): ReleaseTarget {
  const target = TARGETS.find((candidate) => candidate.id === id)
  if (!target) {
    throw new Error(`unknown target ${id}: use ${TARGETS.map((known) => known.id).join(', ')}`)
  }
  return target
}

/** Every file a release of `version` publishes for the desktop app, `latest.json` aside. */
export function releaseFiles(version: string): ReleaseFile[] {
  return TARGETS.flatMap((target) => target.files(version))
}

/** The name of the updater's manifest in a release, which installed apps look up by that name. */
export const MANIFEST_NAME = 'latest.json'
