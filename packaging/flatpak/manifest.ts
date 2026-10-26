/**
 * A Flatpak manifest that repackages a release's `.deb` files (stage 7.5): for trying FXM in
 * Flatpak's sandbox, and for a Flatpak you build yourself. It is not a Flathub submission:
 * Flathub builds open-source apps from source, and its policy refuses manifests written with AI
 * tools, as this one was (README.md, "Flathub").
 *
 * It runs on the GNOME runtime, which brings WebKitGTK 4.1, the webview Tauri uses on Linux,
 * and GStreamer with its base, good and libav plugins, which play Opus and Vorbis. AAC and H.264
 * come from the runtime's codecs-extra extension, which Flatpak installs with the runtime
 * (org.freedesktop.Platform declares it without `no-autodownload`, freedesktop-sdk 26.08's
 * platform.bst, read 2026-10-26).
 *
 * The runtime has no app indicator library, which the app's tray icon loads at runtime
 * (libappindicator-sys, behind Tauri's `tray-icon` feature, panics when it finds none), so the
 * manifest builds libayatana-appindicator with Flathub's own module for it, from a checkout of
 * flathub/shared-modules next to the manifest ({@link SHARED_MODULES}).
 *
 * The release workflow writes it with the release's checksums (.github/workflows/channels.yml);
 * `channels flatpak <x.y.z> --sums SHA256SUMS --out <dir>` does the same by hand.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { DEB_ARCHES, linuxDeb } from '../artifacts.ts'
import { APP_NAME, DESKTOP_BINARY, FLATPAK_ID, REPO_URL } from '../listing.ts'
import { releaseAssetUrl, type Version } from '../version.ts'
import { yamlScalar } from '../yaml.ts'

/** The GNOME runtime: the latest on Flathub on 2026-10-26, built on freedesktop-sdk 26.08. */
export const RUNTIME = { name: 'org.gnome.Platform', sdk: 'org.gnome.Sdk', version: '51' } as const

/**
 * Flathub's shared modules (https://github.com/flathub/shared-modules), which Flathub's apps add
 * as a git submodule next to their manifest: here a checkout in the manifest's folder, at a commit
 * at least two weeks old, the one that last changed `libayatana-appindicator` (2026-02-07).
 */
export const SHARED_MODULES = {
  url: 'https://github.com/flathub/shared-modules.git',
  commit: '3d87a6632cf1e787b009e234b13a8ccfa6d15df8',
  folder: 'shared-modules',
  /** The module that builds libayatana-appindicator for GTK 3, with its dependencies. */
  appIndicator: 'shared-modules/libayatana-appindicator/libayatana-appindicator-gtk3.json',
} as const

/** Where the manifest installs the app's binary, which Flatpak runs as the app's command. */
export const BINARY_PATH = `/app/bin/${DESKTOP_BINARY}`

/**
 * The start of the session bus names that WebKitGTK's media controls (MPRIS) own for the app. An
 * app without a GTK application ID (Tauri sets none by default) and whose program name isn't a
 * valid one (`fxm`) gets the ID `org.webkit.app-<the SHA-256 of its executable's path>`: WTF's
 * `applicationID()` computes it in the app's own process, which hands it to its web processes
 * (`WebProcessPoolGLib.cpp`), and each media session owns
 * `org.mpris.MediaPlayer2.<that ID>.Sandboxed.instance-<n>` (WebCore's `MediaSessionGLib.cpp`;
 * WebKit's sources read 2026-10-26). In the Flatpak the path is always {@link BINARY_PATH}, so
 * the permission names FXM's own names and no other app's.
 */
export function mprisNamePrefix(binaryPath: string = BINARY_PATH): string {
  const id = `org.webkit.app-${createHash('sha256').update(binaryPath).digest('hex')}`
  return `org.mpris.MediaPlayer2.${id}`
}

/**
 * The sandbox's permissions:
 *
 * - the display (Wayland, X11 only where Wayland isn't there) and the GPU;
 * - the network: FXM talks to the music services from the device itself;
 * - sound, through PulseAudio's socket, which PipeWire also serves;
 * - the session bus names the app's parts own: Tauri's single-instance plugin
 *   (`<identifier>.SingleInstance`), the tray icon's watcher, and WebKitGTK's media controls
 *   ({@link mprisNamePrefix}). Flatpak lets an app own only names under its own ID by default,
 *   and the `.deb`'s app is built with the identifier `io.github.pratyayops.fxm` and no GTK
 *   application ID. A build from source with the Flatpak ID as its identifier and
 *   `enableGTKAppId` needs neither `--own-name` (README.md).
 */
export const FINISH_ARGS = [
  '--share=ipc',
  '--socket=wayland',
  '--socket=fallback-x11',
  '--device=dri',
  '--share=network',
  '--socket=pulseaudio',
  '--own-name=io.github.pratyayops.fxm.SingleInstance',
  '--talk-name=org.kde.StatusNotifierWatcher',
  `--own-name=${mprisNamePrefix()}.*`,
] as const

/** The files the manifest's directory holds next to it, copied from the repository. */
export const LOCAL_FILES = {
  metainfo: `${FLATPAK_ID}.metainfo.xml`,
  desktop: `${FLATPAK_ID}.desktop`,
  icon: `${FLATPAK_ID}.svg`,
  license: 'LICENSE',
} as const

/** Options for {@link flatpakManifest}. */
export interface ManifestOptions {
  readonly version: Version
  /** Each `.deb`'s SHA-256, from the release's SHA256SUMS. */
  readonly debSha256: Readonly<Record<(typeof DEB_ARCHES)[number], string>>
}

/** The manifest, as YAML in the style Flathub's guide asks for. */
export function flatpakManifest({ version, debSha256 }: ManifestOptions): string {
  const debSources = DEB_ARCHES.flatMap((arch) => {
    const sum = debSha256[arch]
    if (!/^[\da-f]{64}$/i.test(sum)) throw new Error(`${sum} is not a SHA-256`)
    return [
      '      - type: file',
      `        url: ${yamlScalar(releaseAssetUrl(REPO_URL, version, linuxDeb(version, arch)))}`,
      `        sha256: ${sum.toLowerCase()}`,
      '        dest-filename: fxm.deb',
      '        only-arches:',
      `          - ${arch}`,
    ]
  })
  const fileSources = Object.values(LOCAL_FILES).flatMap((file) => [
    '      - type: file',
    `        path: ${yamlScalar(file)}`,
  ])
  // An app's files go to /app, which flatpak-builder also calls $FLATPAK_DEST.
  const share = '/app/share'
  return [
    `# FXM ${version.text} as a Flatpak, repackaged from the release's .deb files: for trying FXM`,
    '# in the sandbox and for building a Flatpak yourself. Not for Flathub (packaging/flatpak/README.md).',
    `# Written by FXM's packaging/flatpak/manifest.ts (${REPO_URL}).`,
    "# The first module comes from Flathub's shared modules: before building, check out",
    `# ${SHARED_MODULES.url} at ${SHARED_MODULES.commit} into ./${SHARED_MODULES.folder}.`,
    `id: ${FLATPAK_ID}`,
    `runtime: ${RUNTIME.name}`,
    `runtime-version: '${RUNTIME.version}'`,
    `sdk: ${RUNTIME.sdk}`,
    `command: ${DESKTOP_BINARY}`,
    'finish-args:',
    ...FINISH_ARGS.map((arg) => `  - ${yamlScalar(arg)}`),
    '',
    'modules:',
    // The tray icon's library (see the module documentation).
    `  - ${SHARED_MODULES.appIndicator}`,
    '',
    '  - name: fxm',
    '    buildsystem: simple',
    '    build-commands:',
    '      - ar x fxm.deb',
    '      - tar -xf data.tar.*',
    `      - install -Dm755 usr/bin/${DESKTOP_BINARY} ${BINARY_PATH}`,
    // The app's resources, such as the third-party notices of a release build (stage 7.5):
    // Tauri looks for them next to the binary, in ../lib/<productName>.
    `      - if [ -d usr/lib/${APP_NAME} ]; then mkdir -p /app/lib && cp -R usr/lib/${APP_NAME} /app/lib/; fi`,
    `      - install -Dm644 ${LOCAL_FILES.metainfo} ${share}/metainfo/${LOCAL_FILES.metainfo}`,
    `      - install -Dm644 ${LOCAL_FILES.desktop} ${share}/applications/${LOCAL_FILES.desktop}`,
    `      - install -Dm644 ${LOCAL_FILES.icon} ${share}/icons/hicolor/scalable/apps/${LOCAL_FILES.icon}`,
    `      - install -Dm644 LICENSE ${share}/licenses/${FLATPAK_ID}/LICENSE`,
    '    sources:',
    ...debSources,
    ...fileSources,
    '',
  ].join('\n')
}
