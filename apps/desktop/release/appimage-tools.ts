/**
 * The tools that `tauri build` makes the Linux AppImage with, pinned to releases that are not
 * rebuilt and checked against their SHA-256 before anything runs them.
 *
 * The Tauri bundler fetches them from GitHub releases the first time it builds an AppImage, and
 * runs them without any check (`prepare_tools` in `src/bundle/linux/appimage/linuxdeploy.rs` of
 * tauri-bundler 2.10.2, the bundler of the Tauri CLI 2.12.2). They go into its tools folder,
 * `<cargo target dir>/.tauri` with `useLocalToolsDir` (tauri.conf.json):
 *
 * - `AppRun-<arch>`, which every FXM AppImage starts with (it becomes AppDir/AppRun), from the
 *   `apprun-old` release of tauri-apps/binary-releases;
 * - `linuxdeploy-07333c6-<arch>.AppImage`, which assembles the AppDir, from the
 *   `linuxdeploy-07333c6` release there;
 * - `linuxdeploy-plugin-appimage.AppImage`, linuxdeploy's output plugin, from the `continuous`
 *   release of linuxdeploy/linuxdeploy-plugin-appimage, which its CI rebuilds every month. The
 *   plugin runs appimagetool, which writes the AppImage behind the AppImage runtime, the first
 *   bytes of the file. appimagetool downloads that runtime too, from the `continuous` release of
 *   AppImage/type2-runtime, unless it is given a file: `--runtime-file`, which the plugin passes
 *   on from `LDAI_RUNTIME_FILE`.
 *
 * The bundler downloads a tool only when its file is missing. So the release workflow puts each
 * one there first, from a release that is not rebuilt, checked against its SHA-256 below, and the
 * runtime next to them, which the build gets as `LDAI_RUNTIME_FILE` (`release.ts appimage-tools`).
 * A file that doesn't match stops the build before anything has run. After the build,
 * `release.ts appimage-tools --after-build` checks that the folder holds nothing else, as a tool
 * the bundler fetched itself would be there too, and that every AppImage starts with the pinned
 * runtime. The release signs these AppImages with the updater key, so every installed AppImage
 * takes whatever these tools put into them as an update.
 *
 * The file names and releases are the Tauri CLI's: after updating it, compare its bundler's
 * `prepare_tools` with the list below (apps/desktop/README.md, "Maintenance"). Until then the
 * workflow, and a test, refuse a CLI other than {@link TAURI_CLI}.
 *
 * Node runs this file directly (type stripping), which is why the imports spell out `.ts`.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

/** The Tauri CLI whose bundler (tauri-bundler 2.10.2) looks for these tools by these names. */
export const TAURI_CLI = '2.12.2'

/** The linuxdeploy build whose name the bundler gives its file (`LINUXDEPLOY_COMMIT_HASH`). */
const LINUXDEPLOY_BUILD = '07333c6'

/** The plugin's last dated release; its `continuous` one is rebuilt every month. */
const PLUGIN_RELEASE = '1-alpha-20250213-1'

/** type2-runtime's dated release; its `continuous` one is what appimagetool would download. */
const RUNTIME_RELEASE = '20251108'

/** The CPUs FXM's AppImages are for, as the bundler names its tools. */
export type AppImageArch = 'x86_64' | 'aarch64'

/** A file the AppImage build needs, and where it comes from. */
export interface AppImageTool {
  /** Its name in the tools folder: the one the bundler looks for. */
  readonly name: string
  /** A file of a release that is not rebuilt. */
  readonly url: string
  /** The file's SHA-256, in hex. */
  readonly sha256: string
  /** Whether it is the AppImage runtime, which appimagetool copies rather than runs. */
  readonly runtime: boolean
}

/**
 * The SHA-256 of each file, as downloaded on 2026-10-26. GitHub lists the same digests for the
 * release files it has one for (all but the plugin's, which predate them).
 */
const SHA256: Readonly<
  Record<AppImageArch, Readonly<Record<'appRun' | 'linuxdeploy' | 'plugin' | 'runtime', string>>>
> = {
  x86_64: {
    appRun: 'f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f',
    linuxdeploy: '36a2d7e274d12e1050d0e9ecfe11d339ed54720b2bec464c286d53f8b07f5c62',
    plugin: '992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3',
    runtime: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
  },
  aarch64: {
    appRun: '072f17c0895a85c490282fe5395c5007e5fc75da727e553b3b8fb680feb11578',
    linuxdeploy: '556ab80baa98e600aa80f0dcedfb70bca0e1ce7e9f147fb345be3fcc3e91b2b1',
    plugin: '83c292149274965a865dcd44c135cfca8ba28c6b7de3eb628d4b8b5f248af17c',
    runtime: '00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444',
  },
}

const GITHUB = 'https://github.com'

/** The pinned files for one CPU. */
export function appImageTools(arch: AppImageArch): readonly AppImageTool[] {
  const sha256 = SHA256[arch]
  return [
    {
      name: `AppRun-${arch}`,
      url: `${GITHUB}/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-${arch}`,
      sha256: sha256.appRun,
      runtime: false,
    },
    {
      name: `linuxdeploy-${LINUXDEPLOY_BUILD}-${arch}.AppImage`,
      url: `${GITHUB}/tauri-apps/binary-releases/releases/download/linuxdeploy-${LINUXDEPLOY_BUILD}/linuxdeploy-${arch}.AppImage`,
      sha256: sha256.linuxdeploy,
      runtime: false,
    },
    {
      name: 'linuxdeploy-plugin-appimage.AppImage',
      url: `${GITHUB}/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/${PLUGIN_RELEASE}/linuxdeploy-plugin-appimage-${arch}.AppImage`,
      sha256: sha256.plugin,
      runtime: false,
    },
    {
      // A name neither the bundler nor linuxdeploy's plugin search looks at.
      name: `appimage-runtime-${arch}`,
      url: `${GITHUB}/AppImage/type2-runtime/releases/download/${RUNTIME_RELEASE}/runtime-${arch}`,
      sha256: sha256.runtime,
      runtime: true,
    },
  ]
}

/** What the bundler writes into the tools folder itself, from its own binary. */
export const BUNDLER_FILES: readonly string[] = [
  'linuxdeploy-plugin-gtk.sh',
  'linuxdeploy-plugin-gstreamer.sh',
]

/** The CPU of a Rust target triple, as the bundler takes it (`x86_64-unknown-linux-gnu`). */
export function appImageArch(triple: string): AppImageArch {
  const arch = triple.split('-')[0]
  if (arch === 'x86_64' || arch === 'aarch64') return arch
  throw new Error(`No AppImage tools for ${triple}: FXM builds AppImages for x86_64 and aarch64`)
}

/** Fetches a file's bytes. */
export type Download = (url: string) => Promise<Uint8Array>

/** Downloads a file, following GitHub's redirect to its download host. */
export const download: Download = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export interface FetchOptions {
  /** The bundler's tools folder. */
  readonly out: string
  /** The files to fetch: the pinned ones for a CPU. */
  readonly tools: readonly AppImageTool[]
  readonly download?: Download
}

/**
 * Downloads every file and checks each against its SHA-256, then writes them into `out`, every
 * one but the runtime executable. Writes nothing unless every file matches. Returns the runtime's
 * path, for `LDAI_RUNTIME_FILE`, and what it wrote.
 */
export async function fetchAppImageTools({ out, tools, download: get = download }: FetchOptions) {
  const runtimes = tools.filter((tool) => tool.runtime)
  const [runtime] = runtimes
  if (runtime === undefined || runtimes.length > 1) {
    throw new Error('The AppImage tools need exactly one runtime')
  }
  const checked: { tool: AppImageTool; bytes: Uint8Array }[] = []
  for (const tool of tools) {
    const bytes = await get(tool.url)
    const sha256 = sha256Of(bytes)
    if (sha256 !== tool.sha256) {
      throw new Error(
        `${tool.url} has SHA-256 ${sha256}, not ${tool.sha256}: the file changed since it was ` +
          'pinned (apps/desktop/release/appimage-tools.ts), so nothing runs it',
      )
    }
    checked.push({ tool, bytes })
  }
  mkdirSync(out, { recursive: true })
  for (const { tool, bytes } of checked) {
    const path = join(out, tool.name)
    const mode = tool.runtime ? 0o644 : 0o755
    writeFileSync(path, bytes)
    chmodSync(path, mode)
  }
  return {
    runtimeFile: resolve(out, runtime.name),
    files: checked.map(({ tool, bytes }) => ({
      name: tool.name,
      size: bytes.length,
      sha256: tool.sha256,
    })),
  }
}

/** What `out` holds besides the pinned files and the bundler's own: tools it fetched itself. */
export function unexpectedTools(out: string, tools: readonly AppImageTool[]): string[] {
  const expected = new Set([...tools.map((tool) => tool.name), ...BUNDLER_FILES])
  return readdirSync(out)
    .filter((name) => !expected.has(name))
    .sort()
}

/** The MD5 digest of the image that appimagetool writes into the runtime's `.digest_md5`. */
const DIGEST_BYTES = 16

/**
 * Whether an AppImage, from its first bytes, starts with `runtime` as appimagetool embeds it:
 * byte for byte, but for the 16-byte digest it fills in. On 2026-10-26 the dry run's x86_64
 * AppImage matched type2-runtime 20251108 so, differing in one run of 16 bytes.
 */
export function embedsRuntime(head: Uint8Array, runtime: Uint8Array): boolean {
  if (head.length < runtime.length) return false
  let first = -1
  let last = -1
  for (let index = 0; index < runtime.length; index++) {
    if (head[index] !== runtime[index]) {
      if (first < 0) first = index
      last = index
    }
  }
  return first < 0 || last - first < DIGEST_BYTES
}

/** The first `length` bytes of a file, or all of it if it is shorter. */
function readHead(path: string, length: number): Uint8Array {
  const descriptor = openSync(path, 'r')
  try {
    const head = Buffer.alloc(length)
    return head.subarray(0, readSync(descriptor, head, 0, length, 0))
  } finally {
    closeSync(descriptor)
  }
}

export interface AfterBuildCheck {
  /** The bundler's tools folder. */
  readonly out: string
  /** The pinned files for the build's CPU. */
  readonly tools: readonly AppImageTool[]
  /** The bundle folder of the build, `target/<triple>/release/bundle`. */
  readonly bundleDir: string
}

/**
 * Throws unless the build fetched no tool itself and every AppImage it made starts with the
 * pinned runtime, so the file's first bytes are the checked ones, whatever appimagetool did.
 * Returns the names of the AppImages it checked.
 */
export function checkAfterBuild({ out, tools, bundleDir }: AfterBuildCheck): string[] {
  const fetched = unexpectedTools(out, tools)
  if (fetched.length > 0) {
    throw new Error(
      `The bundler fetched tools of its own, unchecked: ${fetched.join(', ')} in ${out}. ` +
        'Pin them in apps/desktop/release/appimage-tools.ts: this build must not be released.',
    )
  }
  const runtime = tools.find((tool) => tool.runtime)
  if (runtime === undefined) throw new Error('The AppImage tools need exactly one runtime')
  const pinned = readFileSync(join(out, runtime.name))
  if (sha256Of(pinned) !== runtime.sha256) {
    throw new Error(`${runtime.name} in ${out} is no longer the pinned AppImage runtime`)
  }
  const folder = join(bundleDir, 'appimage')
  const appImages = existsSync(folder)
    ? readdirSync(folder).filter((name) => name.endsWith('.AppImage'))
    : []
  if (appImages.length === 0) throw new Error(`${folder} holds no AppImage to check`)
  for (const name of appImages) {
    if (!embedsRuntime(readHead(join(folder, name), pinned.length), pinned)) {
      throw new Error(
        `${name} doesn't start with the pinned AppImage runtime (${runtime.url}): appimagetool ` +
          'took another one, so this build must not be released. Check that it still reads ' +
          'LDAI_RUNTIME_FILE (apps/desktop/README.md, "Maintenance").',
      )
    }
  }
  return appImages.sort()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The version of the Tauri CLI in apps/desktop/node_modules, which builds the release. */
export function readTauriCliVersion(
  path = new URL('../node_modules/@tauri-apps/cli/package.json', import.meta.url),
): string {
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const version = isRecord(manifest) ? manifest.version : undefined
  if (typeof version !== 'string') throw new Error(`${String(path)} has no version`)
  return version
}

/** Throws unless `installed` is the Tauri CLI these tools are pinned for. */
export function checkTauriCli(installed: string) {
  if (installed !== TAURI_CLI) {
    throw new Error(
      `The AppImage tools are pinned for the Tauri CLI ${TAURI_CLI}, but ${installed} builds ` +
        "this release: compare its bundler's prepare_tools with apps/desktop/release/" +
        'appimage-tools.ts, update the names, releases and hashes there, then TAURI_CLI ' +
        '(apps/desktop/README.md, "Maintenance")',
    )
  }
}
