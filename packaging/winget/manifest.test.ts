import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { windowsSetup } from '../artifacts.ts'
import { parseVersion } from '../version.ts'
import {
  MANIFEST_VERSION,
  manifestFolder,
  PACKAGE_IDENTIFIER,
  PRODUCT_CODE,
  wingetManifests,
} from './manifest.ts'

const version = parseVersion('0.6.0')
const sha = 'c0ffee'.repeat(10).concat('abcd')

/**
 * winget's JSON schemas for manifest 1.12.0, from microsoft/winget-cli
 * (schemas/JSON/manifests/v1.12.0, MIT, read 2026-10-26): the rules winget-pkgs' validation
 * pipeline applies to these files.
 */
function schema(kind: 'version' | 'defaultLocale' | 'installer') {
  const file = fileURLToPath(
    new URL(`schema/manifest.${kind}.${MANIFEST_VERSION}.json`, import.meta.url),
  )
  return JSON.parse(readFileSync(file, 'utf8')) as object
}

const ajv = new Ajv({ allErrors: true, strict: false })
// The schemas' two formats: a day, and a 64-bit integer.
ajv.addFormat('date', /^\d{4}-\d{2}-\d{2}$/)
ajv.addFormat('long', true)
const validators = {
  version: ajv.compile(schema('version')),
  defaultLocale: ajv.compile(schema('defaultLocale')),
  installer: ajv.compile(schema('installer')),
}

/** The manifests, read back from YAML. */
function manifests(releaseDate?: string) {
  const files = wingetManifests({
    version,
    installerSha256: sha,
    ...(releaseDate === undefined ? {} : { releaseDate }),
  })
  return Object.fromEntries([...files].map(([name, text]) => [name, { text, data: parse(text) }]))
}

describe('the winget manifests', () => {
  it('are a multi-file manifest that passes winget’s 1.12.0 schemas', () => {
    for (const date of [undefined, '2026-12-01']) {
      const files = manifests(date)
      expect(Object.keys(files)).toEqual([
        'FXM.FXM.yaml',
        'FXM.FXM.locale.en-US.yaml',
        'FXM.FXM.installer.yaml',
      ])
      for (const [name, kind] of [
        ['FXM.FXM.yaml', 'version'],
        ['FXM.FXM.locale.en-US.yaml', 'defaultLocale'],
        ['FXM.FXM.installer.yaml', 'installer'],
      ] as const) {
        const validate = validators[kind]
        const { data, text } = files[name] as { data: unknown; text: string }
        expect(validate(data), JSON.stringify(validate.errors)).toBe(true)
        // winget-pkgs wants each file to name its schema in its header.
        expect(text).toContain(
          `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${kind}.${MANIFEST_VERSION}.schema.json`,
        )
      }
    }
  })

  it('agree on the package, its version and its locale', () => {
    for (const { data } of Object.values(manifests())) {
      expect(data).toMatchObject({
        PackageIdentifier: PACKAGE_IDENTIFIER,
        PackageVersion: '0.6.0',
        ManifestVersion: MANIFEST_VERSION,
      })
    }
    expect(manifests()['FXM.FXM.yaml']?.data.DefaultLocale).toBe('en-US')
    expect(manifests()['FXM.FXM.locale.en-US.yaml']?.data.PackageLocale).toBe('en-US')
  })

  it('install the release’s NSIS installer for the user’s account, matched to what it writes', () => {
    const installer = manifests('2026-12-01')['FXM.FXM.installer.yaml']?.data
    expect(installer).toMatchObject({
      InstallerType: 'nullsoft',
      Scope: 'user',
      UpgradeBehavior: 'install',
      ProductCode: PRODUCT_CODE,
      ReleaseDate: '2026-12-01',
      AppsAndFeaturesEntries: [{ DisplayName: 'FXM', Publisher: 'FXM', ProductCode: 'FXM' }],
      Installers: [
        {
          Architecture: 'x64',
          InstallerUrl: `https://github.com/Pratyay-ops/FXM/releases/download/v0.6.0/${windowsSetup(version)}`,
          InstallerSha256: sha.toUpperCase(),
        },
      ],
    })
  })

  it('describe FXM with the listing’s texts and links', () => {
    const locale = manifests()['FXM.FXM.locale.en-US.yaml']?.data
    expect(locale).toMatchObject({
      Publisher: 'FXM',
      PackageName: 'FXM',
      License: 'Apache-2.0',
      Moniker: 'fxm',
      ReleaseNotesUrl: 'https://github.com/Pratyay-ops/FXM/releases/tag/v0.6.0',
      PrivacyUrl: 'https://fxmusic.pages.dev/privacy',
    })
    expect(locale.Description).toMatch(/not affiliated with or endorsed by YouTube/)
    expect(locale.Description).toMatch(/\n- Two modes/)
  })

  it('go where winget-pkgs keeps them, and refuse a checksum or day they can’t use', () => {
    expect(manifestFolder(version)).toBe('manifests/f/FXM/FXM/0.6.0')
    expect(() => wingetManifests({ version, installerSha256: 'abc' })).toThrow(/SHA-256/)
    expect(() =>
      wingetManifests({ version, installerSha256: sha, releaseDate: '1 December' }),
    ).toThrow(/day/)
  })
})
