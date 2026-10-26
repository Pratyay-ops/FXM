import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CRATE_LICENCE_OVERRIDES,
  type CrateTextReview,
  crateDownload,
  crateNotices,
  crateTexts,
  isCrateLicenceFile,
  linkedCrates,
  type Metadata,
  type MetadataPackage,
  NESTED_EXCLUSIONS,
  onlyUnder,
  parseMetadata,
  REVIEWED_CRATE_TEXTS,
  renderDesktopNotices,
  type ShippedCrate,
  shippedCrates,
  spdxExpression,
} from './notices.ts'
import { temporaryFolder } from './testing.ts'

const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index'
const APACHE = 'Apache License\nVersion 2.0, January 2004\n(FXM’s LICENSE)'
const MIT = (holder: string) =>
  `MIT License\n\nCopyright (c) ${holder}\n\nPermission is hereby granted…`

let folder: string
beforeEach(() => {
  folder = temporaryFolder('desktop-notices')
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

/** A crate as crates.io publishes it, in the temporary folder: its Cargo.toml and `files`. */
function crate(
  name: string,
  version: string,
  options: {
    license?: string | null
    files?: Record<string, string>
    kinds?: string[][]
    source?: string | null
    licenseFile?: string
  } = {},
): MetadataPackage {
  const dir = join(folder, 'registry', `${name}-${version}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'Cargo.toml'), `[package]\nname = "${name}"\n`)
  for (const [path, text] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return {
    id: `${CRATES_IO}#${name}@${version}`,
    name,
    version,
    license: options.license === undefined ? 'MIT' : options.license,
    license_file: options.licenseFile ?? null,
    repository: `https://github.com/example/${name}`,
    source: options.source === undefined ? CRATES_IO : options.source,
    manifest_path: join(dir, 'Cargo.toml'),
    targets: (options.kinds ?? [['lib']]).map((kind) => ({ kind })),
  }
}

/** The app's crate: a path dependency, as Cargo reports it. */
const app: MetadataPackage = {
  id: 'path+file:///repo/apps/desktop/src-tauri#fxm@0.0.0',
  name: 'fxm',
  version: '0.0.0',
  license: 'Apache-2.0',
  license_file: null,
  repository: null,
  source: null,
  manifest_path: '/repo/apps/desktop/src-tauri/Cargo.toml',
  targets: [{ kind: ['lib'] }, { kind: ['bin'] }],
}

type Edge = [from: MetadataPackage, to: MetadataPackage, kind?: string | null]

/** `cargo metadata` for a graph of `edges`, normal dependencies unless a kind is given. */
function metadata(edges: Edge[], features: Record<string, string[]> = {}): Metadata {
  const packages = new Map<string, MetadataPackage>([[app.id, app]])
  for (const [from, to] of edges) {
    packages.set(from.id, from)
    packages.set(to.id, to)
  }
  const nodes = [...packages.values()].map((pkg) => ({
    id: pkg.id,
    deps: edges
      .filter(([from]) => from.id === pkg.id)
      .map(([, to, kind = null]) => ({ pkg: to.id, dep_kinds: [{ kind }] })),
    features: features[pkg.name] ?? [],
  }))
  return { packages: [...packages.values()], resolve: { root: app.id, nodes } }
}

/** The crates of one target's graph. */
const shipped = (data: Metadata, target = 'macos-arm64' as const) =>
  shippedCrates(new Map([[target, data]]))

const options = (
  reviews: Record<string, CrateTextReview> = {},
  files: Record<string, string> = {},
) => ({
  apacheLicense: () => APACHE,
  reviewedFile: (name: string) => {
    const text = files[name]
    if (text === undefined) throw new Error(`no file ${name}`)
    return text
  },
  overrides: {},
  reviews,
  exclusions: {},
})

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

describe('parseMetadata', () => {
  it('reads what the notices need from cargo metadata', () => {
    const serde = crate('serde', '1.0.0', { license: 'MIT OR Apache-2.0' })
    const data = parseMetadata(JSON.stringify(metadata([[app, serde]], { serde: ['std'] })))
    expect(data.resolve.root).toBe(app.id)
    expect(data.packages.find((pkg) => pkg.name === 'serde')).toMatchObject({
      license: 'MIT OR Apache-2.0',
      source: CRATES_IO,
      targets: [{ kind: ['lib'] }],
    })
    expect(data.resolve.nodes.find((node) => node.id === serde.id)?.features).toEqual(['std'])
  })

  it('refuses output that is no cargo metadata', () => {
    expect(() => parseMetadata('{"packages": []}')).toThrow(/no packages and resolved graph/)
    expect(() =>
      parseMetadata(JSON.stringify({ packages: [{ id: 'x' }], resolve: { nodes: [] } })),
    ).toThrow(/without its id, name, version or targets/)
  })
})

describe('the crates the app includes', () => {
  it('follow normal dependencies only: build and dev dependencies stay at compile time', () => {
    const serde = crate('serde', '1.0.0')
    const cc = crate('cc', '1.0.0')
    const tempfile = crate('tempfile', '3.0.0')
    const itoa = crate('itoa', '1.0.0')
    const data = metadata([
      [app, serde],
      [app, cc, 'build'],
      [app, tempfile, 'dev'],
      [serde, itoa],
    ])
    expect(linkedCrates(data).map(({ pkg }) => pkg.name)).toEqual(['serde', 'itoa'])
  })

  it('leave out proc macros and what only they use, build scripts and all', () => {
    const serde = crate('serde', '1.0.0')
    const derive = crate('serde_derive', '1.0.0', { kinds: [['proc-macro'], ['custom-build']] })
    const syn = crate('syn', '2.0.0')
    const memchr = crate('memchr', '2.0.0')
    const data = metadata([
      [app, serde],
      [serde, derive],
      [derive, syn],
      // memchr: used by a proc macro, and by the app too.
      [derive, memchr],
      [app, memchr],
    ])
    expect(linkedCrates(data).map(({ pkg }) => pkg.name)).toEqual(['serde', 'memchr'])
  })

  it('come from crates.io, whose copy of their source code the notices point to', () => {
    const fork = crate('tao', '0.37.1', { source: 'git+https://github.com/someone/tao#abc' })
    expect(() => shipped(metadata([[app, fork]]))).toThrow(
      /tao 0\.37\.1 comes from git\+https:\/\/github\.com\/someone\/tao#abc, not crates\.io/,
    )
  })

  it('are listed once, with every target that includes them, in the release’s order', () => {
    const serde = crate('serde', '1.0.0')
    const windows = crate('windows-sys', '0.59.0', { license: 'MIT/Apache-2.0' })
    const crates = shippedCrates(
      new Map([
        [
          'windows-x64',
          metadata([
            [app, serde],
            [app, windows],
          ]),
        ],
        ['macos-arm64', metadata([[app, serde]])],
      ]),
    )
    expect(crates.map(({ name, targets, license }) => ({ name, targets, license }))).toEqual([
      { name: 'serde', targets: ['macos-arm64', 'windows-x64'], license: 'MIT' },
      // Cargo's old syntax, as SPDX writes it.
      { name: 'windows-sys', targets: ['windows-x64'], license: 'MIT OR Apache-2.0' },
    ])
  })

  it('read Cargo’s old licence syntax as SPDX', () => {
    expect(spdxExpression('MIT/Apache-2.0')).toBe('MIT OR Apache-2.0')
    expect(spdxExpression('Apache-2.0 / MIT')).toBe('Apache-2.0 OR MIT')
    expect(spdxExpression('  ')).toBeUndefined()
    expect(spdxExpression(null)).toBeUndefined()
  })
})

describe('a crate’s licence texts', () => {
  it('are its licence, copying, copyright and notice files, root first', () => {
    for (const name of ['LICENSE', 'LICENSE-MIT', 'license-apache-2.0', 'COPYING', 'UNLICENSE']) {
      expect(isCrateLicenceFile(name), name).toBe(true)
    }
    for (const name of ['COPYRIGHT', 'NOTICE.md', 'LICENCE.txt', 'LICENSES/MIT.txt']) {
      expect(isCrateLicenceFile(name), name).toBe(true)
    }
    for (const name of ['LICENSE.spdx', 'license.rs', 'README.md', 'src/licensing.rs']) {
      expect(isCrateLicenceFile(name), name).toBe(false)
    }
  })

  it('include those deeper in it, for code it took from elsewhere, but not its tests', () => {
    const ring = crate('ring', '0.17.14', {
      files: {
        LICENSE: 'ring',
        'third_party/fiat/LICENSE': 'fiat',
        'src/polyfill/once_cell/LICENSE-MIT': 'once_cell',
        'tests/data/LICENSE': 'test data',
        'src/lib.rs': '// licensed under…',
      },
      licenseFile: 'LICENSE',
    })
    const [shippedRing] = shipped(metadata([[app, ring]]))
    expect(crateTexts(shippedRing as ShippedCrate, {}).map(({ label }) => label)).toEqual([
      'LICENSE',
      'src/polyfill/once_cell/LICENSE-MIT',
      'third_party/fiat/LICENSE',
    ])
  })

  it('include its license-file, whatever it is called', () => {
    const odd = crate('odd', '1.0.0', {
      license: null,
      files: { 'TERMS.txt': 'terms' },
      licenseFile: 'TERMS.txt',
    })
    const [shippedOdd] = shipped(metadata([[app, odd]]))
    expect(crateTexts(shippedOdd as ShippedCrate, {})).toEqual([
      { label: 'TERMS.txt', text: 'terms' },
    ])
  })

  it('leave out what NESTED_EXCLUSIONS reviewed, unless the build turns its feature on', () => {
    const files = { 'LICENSE-MIT': 'bindings', 'vendor/dbus/COPYING': 'AFL-2.1 OR GPL-2.0' }
    const exclusions = {
      'libdbus-sys': [{ folder: 'vendor/', unlessFeature: 'vendored', reason: 'test' }],
    }
    const sys = crate('libdbus-sys', '0.2.7', { files })
    const [plain] = shipped(metadata([[app, sys]], { 'libdbus-sys': ['pkg-config'] }))
    expect(crateTexts(plain as ShippedCrate, exclusions).map(({ label }) => label)).toEqual([
      'LICENSE-MIT',
    ])
    const [vendored] = shipped(metadata([[app, sys]], { 'libdbus-sys': ['vendored'] }))
    expect(crateTexts(vendored as ShippedCrate, exclusions).map(({ label }) => label)).toEqual([
      'LICENSE-MIT',
      'vendor/dbus/COPYING',
    ])
  })

  it('keep the first line’s indentation, without blank lines around them', () => {
    const apache = crate('apache', '1.0.0', {
      files: { LICENSE: '\r\n\r\n    Apache License\r\n  Version 2.0\r\n\r\n' },
    })
    const [shippedApache] = shipped(metadata([[app, apache]]))
    expect(crateTexts(shippedApache as ShippedCrate, {})[0]?.text).toBe(
      '    Apache License\n  Version 2.0',
    )
  })
})

describe('the crates’ notices', () => {
  it('give each licence text once, with the crates whose copies it is', () => {
    const a = crate('a', '1.0.0', { files: { 'LICENSE-APACHE': APACHE, 'LICENSE-MIT': MIT('A') } })
    const b = crate('b', '2.0.0', { files: { 'LICENSE-APACHE': APACHE, 'LICENSE-MIT': MIT('B') } })
    const notices = crateNotices(
      shipped(
        metadata([
          [app, a],
          [app, b],
        ]),
      ),
      options(),
    )
    expect(notices.problems).toEqual([])
    expect(
      notices.groups.map((group) => [
        group.text,
        group.covers.map(({ crate, label }) => `${crate.name} ${label}`),
      ]),
    ).toEqual([
      [APACHE, ['a LICENSE-APACHE', 'b LICENSE-APACHE']],
      [MIT('A'), ['a LICENSE-MIT']],
      [MIT('B'), ['b LICENSE-MIT']],
    ])
  })

  it('refuse GPL, and a licence outside FXM’s policy until a review', () => {
    const gpl = crate('gpl', '1.0.0', { license: 'GPL-3.0-only', files: { COPYING: 'GPL' } })
    const data = crate('roots', '1.0.0', {
      license: 'CDLA-Permissive-2.0',
      files: { LICENSE: 'CDLA' },
    })
    const graph = shipped(
      metadata([
        [app, gpl],
        [app, data],
      ]),
    )
    expect(crateNotices(graph, options()).problems).toEqual([
      'gpl 1.0.0: GPL-3.0-only is GPL or AGPL, which FXM must not ship (ARCHITECTURE.md §17)',
      'roots 1.0.0: CDLA-Permissive-2.0 is not a licence FXM accepts (ACCEPTED_LICENCES in scripts/build-dist/src/licenses.ts): check it and record the review in CRATE_LICENCE_OVERRIDES in apps/desktop/release/notices.ts',
    ])
    const reviewed = {
      ...options(),
      overrides: { roots: { expression: 'CDLA-Permissive-2.0', reason: 'test' } },
    }
    expect(crateNotices(graph, reviewed).problems).toEqual([
      'gpl 1.0.0: GPL-3.0-only is GPL or AGPL, which FXM must not ship (ARCHITECTURE.md §17)',
    ])
    // A review holds for the expression it reviewed only.
    const stale = {
      ...options(),
      overrides: { roots: { expression: 'CDLA-Sharing-1.0', reason: 'test' } },
    }
    expect(crateNotices(shipped(metadata([[app, data]])), stale).problems).toEqual([
      'roots 1.0.0: its licence is CDLA-Permissive-2.0, but CRATE_LICENCE_OVERRIDES reviewed CDLA-Sharing-1.0: check it again and update the review',
    ])
  })

  it('stop at a crate without licence text, until a review says what covers it', () => {
    const bare = crate('objc2', '0.6.5', { license: 'MIT' })
    const graph = shipped(metadata([[app, bare]]))
    expect(crateNotices(graph, options()).problems).toEqual([
      'objc2 0.6.5 ships no licence text (its licence is MIT): check what covers it and update REVIEWED_CRATE_TEXTS in apps/desktop/release/notices.ts',
    ])
    const text = MIT('Mads Marquart')
    const review: CrateTextReview = {
      version: '0.6.5',
      expression: 'MIT',
      license: 'MIT',
      text: { file: 'objc2.txt', source: 'https://example.com/LICENSE', sha256: sha256(text) },
      reason: 'test',
    }
    const notices = crateNotices(graph, options({ objc2: review }, { 'objc2.txt': text }))
    expect(notices.problems).toEqual([])
    expect(notices.groups).toEqual([
      {
        text,
        covers: [
          {
            crate: graph[0],
            label: 'no licence file: its repository’s, https://example.com/LICENSE',
          },
        ],
      },
    ])
    // The reviewed file, as it was reviewed.
    expect(
      crateNotices(graph, options({ objc2: review }, { 'objc2.txt': `${text} changed` })).problems,
    ).toEqual([
      "objc2 0.6.5: release/licences/objc2.txt isn't the file REVIEWED_CRATE_TEXTS reviewed (its SHA-256 changed): check what covers it and update REVIEWED_CRATE_TEXTS in apps/desktop/release/notices.ts",
    ])
  })

  it('take a reviewed text from FXM’s licence, or from a crate of the same project', () => {
    const trio = crate('dispatch2', '0.3.1', { license: 'Zlib OR Apache-2.0 OR MIT' })
    const css = crate('cssparser', '0.37.0', {
      license: 'MPL-2.0',
      files: { LICENSE: 'MPL 2.0 text' },
    })
    const selectors = crate('selectors', '0.38.0', { license: 'MPL-2.0' })
    const reviews: Record<string, CrateTextReview> = {
      dispatch2: {
        version: '0.3.1',
        expression: 'Zlib OR Apache-2.0 OR MIT',
        license: 'Apache-2.0',
        text: { apache: true },
        reason: 'test',
      },
      selectors: {
        version: '0.38.0',
        expression: 'MPL-2.0',
        license: 'MPL-2.0',
        text: { crate: 'cssparser' },
        reason: 'test',
      },
    }
    const graph = shipped(
      metadata([
        [app, trio],
        [app, css],
        [app, selectors],
      ]),
    )
    const notices = crateNotices(graph, options(reviews))
    expect(notices.problems).toEqual([])
    expect(
      notices.groups.map((group) => [
        group.text,
        group.covers.map(({ crate, label }) => `${crate.name}: ${label}`),
      ]),
    ).toEqual([
      [
        'MPL 2.0 text',
        ['cssparser: LICENSE', 'selectors: no licence file: MPL-2.0, as cssparser ships it'],
      ],
      [APACHE, ['dispatch2: no licence file: the Apache License 2.0, FXM’s own']],
    ])
    // Without cssparser, selectors' review no longer holds.
    expect(crateNotices(shipped(metadata([[app, selectors]])), options(reviews)).problems).toEqual([
      "selectors 0.38.0: REVIEWED_CRATE_TEXTS takes its licence text from cssparser, which the app doesn't include, or which ships none: check what covers it and update REVIEWED_CRATE_TEXTS in apps/desktop/release/notices.ts",
    ])
  })

  it('hold a review only while the crate’s licence stays the one reviewed', () => {
    const relicensed = crate('dispatch2', '0.4.0', { license: 'MIT' })
    const review: CrateTextReview = {
      version: '0.3.1',
      expression: 'Zlib OR Apache-2.0 OR MIT',
      license: 'Apache-2.0',
      text: { apache: true },
      reason: 'test',
    }
    expect(
      crateNotices(shipped(metadata([[app, relicensed]])), options({ dispatch2: review })).problems,
    ).toEqual([
      'dispatch2 0.4.0: its licence is MIT, but REVIEWED_CRATE_TEXTS reviewed Zlib OR Apache-2.0 OR MIT (version 0.3.1): check what covers it and update REVIEWED_CRATE_TEXTS in apps/desktop/release/notices.ts',
    ])
    const later = crate('dispatch2', '0.3.9', { license: '(Zlib OR Apache-2.0) OR MIT' })
    expect(
      crateNotices(shipped(metadata([[app, later]])), options({ dispatch2: review })).problems,
    ).toEqual([])
  })

  it('name the crates FXM may ship only under the MPL, whose source code the notices point to', () => {
    expect(onlyUnder('MPL-2.0', /^MPL-/)).toBe(true)
    expect(onlyUnder('MPL-2.0 AND MIT', /^MPL-/)).toBe(true)
    expect(onlyUnder('MIT OR MPL-2.0', /^MPL-/)).toBe(false)
    expect(onlyUnder('MIT', /^MPL-/)).toBe(false)
    const css = crate('cssparser', '0.37.0', { license: 'MPL-2.0', files: { LICENSE: 'MPL' } })
    const either = crate('either-way', '1.0.0', {
      license: 'MIT OR MPL-2.0',
      files: { LICENSE: 'MIT' },
    })
    const notices = crateNotices(
      shipped(
        metadata([
          [app, css],
          [app, either],
        ]),
      ),
      options(),
    )
    expect(notices.sourceCrates.map((crate) => crate.name)).toEqual(['cssparser'])
    expect(crateDownload({ name: 'cssparser', version: '0.37.0' })).toBe(
      'https://static.crates.io/crates/cssparser/cssparser-0.37.0.crate',
    )
  })
})

describe('the desktop notices file', () => {
  it('lists the crates with their licences and targets, their texts once, then make dist’s', () => {
    const css = crate('cssparser', '0.37.0', { license: 'MPL-2.0', files: { LICENSE: 'MPL text' } })
    const serde = crate('serde', '1.0.0', {
      license: 'MIT OR Apache-2.0',
      files: { 'LICENSE-APACHE': APACHE, 'LICENSE-MIT': MIT('Serde') },
    })
    const windows = crate('windows-sys', '0.59.0', {
      license: 'MIT OR Apache-2.0',
      files: { 'license-apache-2.0': APACHE },
    })
    const all = metadata([
      [app, serde],
      [app, css],
    ])
    const crates = shippedCrates(
      new Map([
        ['macos-arm64', all],
        ['macos-x64', all],
        [
          'windows-x64',
          metadata([
            [app, serde],
            [app, css],
            [app, windows],
          ]),
        ],
        ['linux-x64', all],
        ['linux-arm64', all],
      ]),
    )
    const web = 'FXM third-party notices\r\n\r\nFXM is open source…\r\n'
    const text = renderDesktopNotices({
      version: '1.2.3',
      repositoryUrl: 'https://github.com/Pratyay-ops/FXM',
      rustVersion: '1.98.1',
      crates: crateNotices(crates, options()),
      web,
    })
    expect(text.startsWith('FXM desktop app: third-party notices\nVersion 1.2.3\n')).toBe(true)
    expect(text).toContain('library of Rust 1.98.1 (MIT OR Apache-2.0')
    expect(text).toContain(
      '  cssparser 0.37.0: https://static.crates.io/crates/cssparser/cssparser-0.37.0.crate\n',
    )
    expect(text).toContain(
      '  serde 1.0.0: MIT OR Apache-2.0, all\n    https://github.com/example/serde\n',
    )
    expect(text).toContain('  windows-sys 0.59.0: MIT OR Apache-2.0, windows-x64\n')
    // The Apache text once, for both crates, with where each copy comes from.
    expect(text.split(APACHE)).toHaveLength(2)
    expect(text).toContain(
      'For serde 1.0.0 (LICENSE-APACHE), windows-sys 0.59.0 (license-apache-2.0):',
    )
    // make dist's notices, as they are, with Unix line endings.
    expect(
      text.endsWith('Part 2: The web app\n\nFXM third-party notices\n\nFXM is open source…\n'),
    ).toBe(true)
  })
})

describe('the reviews', () => {
  const licences = new URL('./licences/', import.meta.url)

  it('take each reviewed file, unchanged, from release/licences/', () => {
    for (const [name, review] of Object.entries(REVIEWED_CRATE_TEXTS)) {
      if (!('file' in review.text)) continue
      const text = readFileSync(new URL(review.text.file, licences), 'utf8')
      expect(sha256(text), `${name}: ${review.text.file}`).toBe(review.text.sha256)
      expect(review.text.source).toMatch(
        /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[0-9a-f]{40}\//,
      )
    }
  })

  it('use each crate under a licence that its expression offers', () => {
    for (const [name, review] of Object.entries(REVIEWED_CRATE_TEXTS)) {
      expect(spdxExpression(review.expression), name).toBe(review.expression)
      expect(review.expression.split(/\s+(?:OR|AND)\s+/), name).toContain(review.license)
      expect(review.reason, name).toMatch(/Reviewed \d{4}-\d{2}-\d{2}\./)
    }
    for (const [name, review] of Object.entries(CRATE_LICENCE_OVERRIDES)) {
      expect(review.reason, name).toMatch(/Reviewed \d{4}-\d{2}-\d{2}/)
    }
    for (const [name, exclusions] of Object.entries(NESTED_EXCLUSIONS)) {
      for (const exclusion of exclusions) expect(exclusion.folder, name).toMatch(/\/$/)
    }
  })
})
