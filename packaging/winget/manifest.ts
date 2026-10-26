/**
 * FXM's manifests for winget, the Windows Package Manager: the three files of a multi-file
 * manifest (version, default locale, installer) that a pull request to microsoft/winget-pkgs adds
 * for each release, in schema 1.12.0, the version that repository asks for (its pull request
 * template and doc/Authoring.md, read 2026-10-26). They install the release's NSIS installer for
 * the user's account (stage 7.5), which needs no administrator rights.
 *
 * The release workflow writes them for every release that has the Windows installer
 * (.github/workflows/channels.yml); README.md says how the owner submits them. Imports nothing
 * but this package's own modules, so Node alone runs it there.
 *
 * @module
 */

import { windowsSetup } from '../artifacts.ts'
import {
  APP_NAME,
  DEVELOPER,
  description,
  ISSUES_URL,
  KEYWORDS,
  LICENSE,
  LICENSE_URL,
  PRIVACY_URL,
  PUBLISHER,
  REPO_URL,
  SITE_URL,
  TAGLINE,
} from '../listing.ts'
import { releaseAssetUrl, releasePageUrl, type Version } from '../version.ts'
import { yamlBlock, yamlScalar } from '../yaml.ts'

/**
 * The package's identifier, `Publisher.Package`: the publisher the installer writes to Windows'
 * list of installed apps (`bundle.publisher` in tauri.conf.json) and the app's name. Nothing in
 * winget-pkgs used it on 2026-10-26.
 */
export const PACKAGE_IDENTIFIER = `${PUBLISHER}.${APP_NAME}`

/** The manifest schema version winget-pkgs accepts. */
export const MANIFEST_VERSION = '1.12.0'

/** The locale of the texts. */
export const LOCALE = 'en-US'

/**
 * The installer's entry in Windows' list of installed apps: Tauri's NSIS installer writes
 * `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<productName>` with the product name
 * as `DisplayName` and the publisher as `Publisher` (tauri-bundler's installer.nsi, read
 * 2026-10-26). winget matches an installed FXM to the package by it.
 */
export const PRODUCT_CODE = APP_NAME

/** Where winget-pkgs keeps a version's manifests: `manifests/f/FXM/FXM/<version>`. */
export function manifestFolder(version: Version): string {
  const [publisher, name] = PACKAGE_IDENTIFIER.split('.') as [string, string]
  return `manifests/${publisher.charAt(0).toLowerCase()}/${publisher}/${name}/${version.text}`
}

/** Options for {@link wingetManifests}. */
export interface WingetOptions {
  readonly version: Version
  /** The SHA-256 of the release's NSIS installer, from its SHA256SUMS. */
  readonly installerSha256: string
  /** The day the release was published, `YYYY-MM-DD`, if known. */
  readonly releaseDate?: string
}

/** The comment each file starts with: who wrote it, and the schema editors validate it against. */
function header(kind: 'version' | 'defaultLocale' | 'installer'): string[] {
  return [
    `# Written by FXM's release workflow (packaging/winget in ${REPO_URL})`,
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${kind}.${MANIFEST_VERSION}.schema.json`,
    '',
  ]
}

/** The description, as plain text. */
export function wingetDescription(): string {
  const { intro, features, paragraphs } = description('desktop')
  return [intro, features.map((feature) => `- ${feature}`).join('\n'), ...paragraphs].join('\n\n')
}

/** The three manifests, by file name. */
export function wingetManifests({
  version,
  installerSha256,
  releaseDate,
}: WingetOptions): Map<string, string> {
  if (!/^[\da-f]{64}$/i.test(installerSha256)) {
    throw new Error(`${installerSha256} is not a SHA-256`)
  }
  if (releaseDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    throw new Error(`${releaseDate} is not a day YYYY-MM-DD`)
  }
  const identity = [
    `PackageIdentifier: ${yamlScalar(PACKAGE_IDENTIFIER)}`,
    `PackageVersion: ${yamlScalar(version.text)}`,
  ]
  const footer = (kind: string) => [
    `ManifestType: ${kind}`,
    `ManifestVersion: ${MANIFEST_VERSION}`,
    '',
  ]
  const installerUrl = releaseAssetUrl(REPO_URL, version, windowsSetup(version))

  const versionFile = [
    ...header('version'),
    ...identity,
    `DefaultLocale: ${LOCALE}`,
    ...footer('version'),
  ]
  const localeFile = [
    ...header('defaultLocale'),
    ...identity,
    `PackageLocale: ${LOCALE}`,
    `Publisher: ${yamlScalar(PUBLISHER)}`,
    `PublisherUrl: ${yamlScalar(REPO_URL)}`,
    `PublisherSupportUrl: ${yamlScalar(ISSUES_URL)}`,
    `PrivacyUrl: ${yamlScalar(PRIVACY_URL)}`,
    `Author: ${yamlScalar(DEVELOPER)}`,
    `PackageName: ${yamlScalar(APP_NAME)}`,
    `PackageUrl: ${yamlScalar(SITE_URL)}`,
    `License: ${yamlScalar(LICENSE)}`,
    `LicenseUrl: ${yamlScalar(LICENSE_URL)}`,
    `ShortDescription: ${yamlScalar(TAGLINE)}`,
    `Description: ${yamlBlock(wingetDescription(), 2)}`,
    `Moniker: ${APP_NAME.toLowerCase()}`,
    'Tags:',
    ...KEYWORDS.map((keyword) => `- ${yamlScalar(keyword)}`),
    `ReleaseNotesUrl: ${yamlScalar(releasePageUrl(REPO_URL, version))}`,
    ...footer('defaultLocale'),
  ]
  const installerFile = [
    ...header('installer'),
    ...identity,
    `InstallerLocale: ${LOCALE}`,
    'InstallerType: nullsoft',
    'Scope: user',
    'InstallModes:',
    '- interactive',
    '- silent',
    '- silentWithProgress',
    'UpgradeBehavior: install',
    `ProductCode: ${yamlScalar(PRODUCT_CODE)}`,
    ...(releaseDate === undefined ? [] : [`ReleaseDate: ${releaseDate}`]),
    'AppsAndFeaturesEntries:',
    `- DisplayName: ${yamlScalar(APP_NAME)}`,
    `  Publisher: ${yamlScalar(PUBLISHER)}`,
    `  ProductCode: ${yamlScalar(PRODUCT_CODE)}`,
    'Installers:',
    '- Architecture: x64',
    `  InstallerUrl: ${yamlScalar(installerUrl)}`,
    `  InstallerSha256: ${installerSha256.toUpperCase()}`,
    ...footer('installer'),
  ]
  return new Map([
    [`${PACKAGE_IDENTIFIER}.yaml`, versionFile.join('\n')],
    [`${PACKAGE_IDENTIFIER}.locale.${LOCALE}.yaml`, localeFile.join('\n')],
    [`${PACKAGE_IDENTIFIER}.installer.yaml`, installerFile.join('\n')],
  ])
}
