import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACCEPTED_LICENCES,
  APK_NOTICES_PATH,
  apkNotices,
  isApacheLicenceText,
  type LibraryReport,
  type LibraryReview,
  NOTICES_FILE,
  NOTICES_TITLE,
  npmPackageOf,
  parseLibraryReport,
  REPOSITORY_URL,
  REVIEWED_LIBRARIES,
  type ReportedLibrary,
  spdxOf,
  WEB_NOTICES_TITLE,
} from './notices.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/** The repository's LICENSE: the Apache License 2.0. */
const APACHE = read('../../../LICENSE')

/** AndroidX's copy in its AARs: the licence's terms without the appendix, laid out otherwise. */
const ANDROIDX_LICENCE = `\n${APACHE.slice(0, APACHE.indexOf('END OF TERMS AND CONDITIONS') + 27).replace(/ {3}/g, ' ')}\n`

const WEB = `${WEB_NOTICES_TITLE}

FXM is open source under the Apache License 2.0: ${REPOSITORY_URL}
Its website, web app and embed include code from the open-source packages below, each under its own licence.

==============================================================================
react 19.3.0
Licence: MIT
Used in: app
`

const APACHE_POM = {
  name: 'The Apache Software License, Version 2.0',
  url: 'http://www.apache.org/licenses/LICENSE-2.0.txt',
}

function library(overrides: Partial<ReportedLibrary> = {}): ReportedLibrary {
  return {
    group: 'androidx.media3',
    name: 'media3-exoplayer',
    version: '1.11.1',
    title: 'Media3 ExoPlayer module',
    url: '',
    licences: [APACHE_POM],
    files: ['media3-exoplayer-1.11.1.aar'],
    notices: [],
    ...overrides,
  }
}

let root: string

/** A repository with the app's module, and Capacitor's runtime in node_modules. */
function repository() {
  const app = join(root, 'apps/mobile/android/app')
  mkdirSync(app, { recursive: true })
  const capacitor = join(
    root,
    'node_modules/.pnpm/@capacitor+android@8.5.3/node_modules/@capacitor/android',
  )
  mkdirSync(join(capacitor, 'capacitor'), { recursive: true })
  writeFileSync(
    join(capacitor, 'package.json'),
    JSON.stringify({
      name: '@capacitor/android',
      version: '8.5.3',
      license: 'MIT',
      homepage: 'https://capacitorjs.com',
    }),
  )
  writeFileSync(
    join(capacitor, 'LICENSE'),
    'MIT License\n\nCopyright (c) 2017-present Drifty Co.\n',
  )
  return { app, capacitor: join(capacitor, 'capacitor') }
}

function report(overrides: Partial<LibraryReport> = {}): LibraryReport {
  const { app, capacitor } = repository()
  return {
    app,
    libraries: [library()],
    projects: [
      { path: ':capacitor-android', dir: capacitor },
      { path: ':fxm-http', dir: join(root, 'apps/mobile/android/fxm-http') },
    ],
    ...overrides,
  }
}

const notices = (input: {
  report: LibraryReport
  web?: string
  reviewed?: Record<string, LibraryReview>
}) => apkNotices({ web: WEB, apacheLicence: APACHE, root, ...input })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fxm-notices-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('spdxOf', () => {
  it.each([
    ['The Apache Software License, Version 2.0', 'http://www.apache.org/licenses/LICENSE-2.0.txt'],
    ['Apache License, Version 2.0', 'https://www.apache.org/licenses/LICENSE-2.0.txt'],
    ['The Apache License, Version 2.0', ''],
    ['Apache-2.0', 'http://www.apache.org/licenses/LICENSE-2.0.txt'],
    ['Apache 2.0', ''],
    ['', 'https://opensource.org/licenses/Apache-2.0'],
  ])(
    'reads %j (%s) as the Apache License 2.0, as AndroidX, Kotlin and OkHttp name it',
    (name, url) => {
      expect(spdxOf({ name, url })).toBe('Apache-2.0')
    },
  )

  it.each([
    [{ name: 'The MIT License', url: 'http://opensource.org/licenses/MIT' }, 'MIT'],
    [{ name: 'MIT', url: '' }, 'MIT'],
    [{ name: 'New BSD License', url: '' }, 'BSD-3-Clause'],
    [{ name: 'BSD-3-Clause', url: '' }, 'BSD-3-Clause'],
    [{ name: '', url: 'https://opensource.org/licenses/BSD-2-Clause' }, 'BSD-2-Clause'],
    [{ name: 'ISC License', url: '' }, 'ISC'],
  ])('reads %j as %s', (licence, id) => {
    expect(spdxOf(licence)).toBe(id)
  })

  it.each([
    { name: 'BSD License', url: '' },
    {
      name: 'GNU General Public License, version 2',
      url: 'https://www.gnu.org/licenses/gpl-2.0.html',
    },
    { name: 'Eclipse Public License 1.0', url: '' },
    { name: '', url: '' },
    // Name and link that disagree name no one licence.
    { name: 'The MIT License', url: 'http://www.apache.org/licenses/LICENSE-2.0.txt' },
  ])('recognizes no licence in %j', (licence) => {
    expect(spdxOf(licence)).toBeUndefined()
  })
})

describe('parseLibraryReport', () => {
  const json = (value: unknown) => JSON.stringify(value)

  it('reads what fxmLibraryReport writes', () => {
    const parsed = parseLibraryReport(
      json({
        configuration: 'releaseRuntimeClasspath',
        app: '/repo/apps/mobile/android/app',
        libraries: [{ ...library(), notices: [{ path: 'META-INF/NOTICE', text: 'Notice' }] }],
        projects: [{ path: ':fxm-http', dir: '/repo/apps/mobile/android/fxm-http' }],
      }),
    )
    expect(parsed.libraries[0]?.notices).toEqual([{ path: 'META-INF/NOTICE', text: 'Notice' }])
    expect(parsed.projects).toEqual([
      { path: ':fxm-http', dir: '/repo/apps/mobile/android/fxm-http' },
    ])
  })

  it('refuses a report of another configuration than the release build’s', () => {
    expect(() =>
      parseLibraryReport(
        json({ configuration: 'debugRuntimeClasspath', app: '/a', libraries: [], projects: [] }),
      ),
    ).toThrow('not of the release build')
  })

  it('refuses a report that lacks what the notices need', () => {
    expect(() =>
      parseLibraryReport(
        json({
          configuration: 'releaseRuntimeClasspath',
          app: '/a',
          libraries: [{ ...library(), files: 'media3.aar' }],
          projects: [],
        }),
      ),
    ).toThrow('library 1: files is not a list')
  })
})

describe('isApacheLicenceText', () => {
  it('knows the licence with and without its appendix, whatever the layout', () => {
    expect(isApacheLicenceText(APACHE, APACHE)).toBe(true)
    expect(isApacheLicenceText(ANDROIDX_LICENCE, APACHE)).toBe(true)
  })

  it('keeps a file that adds anything to the licence', () => {
    expect(
      isApacheLicenceText(`${APACHE}\nThis product bundles zlib (zlib License).`, APACHE),
    ).toBe(false)
    expect(isApacheLicenceText('Copyright 2026 Example', APACHE)).toBe(false)
  })
})

describe('npmPackageOf', () => {
  it('finds the npm package an Android project is in', () => {
    const { capacitor } = repository()
    expect(npmPackageOf(capacitor)).toMatchObject({
      name: '@capacitor/android',
      version: '8.5.3',
      license: 'MIT',
      licenceFiles: [{ path: 'LICENSE', text: expect.stringContaining('Drifty Co.') }],
    })
  })

  it('finds none outside node_modules', () => {
    const { app } = repository()
    expect(npmPackageOf(app)).toBeUndefined()
  })
})

describe('apkNotices', () => {
  it('lists the Android libraries, then make dist’s notices, and ends with the Apache License 2.0', () => {
    const result = notices({ report: report() })
    expect(result.problems).toEqual([])
    const lines = result.text.split('\n')
    expect(lines[0]).toBe(NOTICES_TITLE)
    expect(result.text).toContain(
      `FXM is open source under the Apache License 2.0: ${REPOSITORY_URL}`,
    )
    const part1 = result.text.indexOf('Part 1: Android libraries')
    const part2 = result.text.indexOf('Part 2: the web app')
    expect(part1).toBeGreaterThan(0)
    expect(part2).toBeGreaterThan(part1)
    expect(
      result.text.indexOf('androidx.media3:media3-exoplayer 1.11.1 (Media3 ExoPlayer module)'),
    ).toBeGreaterThan(part1)
    expect(result.text).toContain('Licence: Apache-2.0')
    // Capacitor's runtime, built from its npm package, with its own licence text.
    expect(result.text).toContain(
      '@capacitor/android 8.5.3 (built from the Android project in its npm package)',
    )
    expect(result.text).toContain('Copyright (c) 2017-present Drifty Co.')
    // make dist's notices as they are, after Part 2's heading.
    expect(result.text.indexOf(WEB.trim())).toBeGreaterThan(part2)
    expect(result.text.trimEnd().endsWith(APACHE.trim())).toBe(true)
    expect(result.listed).toEqual([
      'androidx.media3:media3-exoplayer 1.11.1',
      '@capacitor/android 8.5.3',
    ])
  })

  it('gives the Apache License 2.0 once when make dist’s notices end with it already', () => {
    const web = `${WEB}\n${'='.repeat(78)}\nThe Apache License 2.0\n\n${APACHE.trim()}\n`
    const { text } = notices({ report: report(), web })
    expect(text.split('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')).toHaveLength(
      2,
    )
    expect(text.trimEnd().endsWith(APACHE.trim())).toBe(true)
  })

  it('leaves out what puts no files into the APK: a BOM, a multiplatform library’s root', () => {
    const bom = library({
      group: 'org.jetbrains.kotlinx',
      name: 'kotlinx-coroutines-bom',
      version: '1.8.1',
      files: [],
    })
    const { text, problems } = notices({ report: report({ libraries: [library(), bom] }) })
    expect(problems).toEqual([])
    expect(text).not.toContain('kotlinx-coroutines-bom')
  })

  it('skips copies of the Apache License 2.0 in the libraries, but keeps their NOTICE files', () => {
    const activity = library({
      group: 'androidx.activity',
      name: 'activity',
      version: '1.11.0',
      title: 'Activity',
      notices: [
        { path: 'META-INF/androidx/activity/activity/LICENSE.txt', text: ANDROIDX_LICENCE },
        {
          path: 'classes.jar!/META-INF/NOTICE',
          text: 'Activity\nCopyright 2026 The Android Open Source Project',
        },
      ],
    })
    const { text, problems } = notices({ report: report({ libraries: [activity] }) })
    expect(problems).toEqual([])
    expect(text).toContain('Copyright 2026 The Android Open Source Project')
    expect(text.split('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')).toHaveLength(
      2,
    )
  })

  it('refuses a library whose POM declares no licence it recognizes, until a human reviews it', () => {
    const unknown = library({
      group: 'org.example',
      name: 'mystery',
      version: '1.0',
      title: '',
      licences: [{ name: 'BSD License', url: '' }],
    })
    const result = notices({ report: report({ libraries: [unknown] }) })
    expect(result.problems).toEqual([
      'org.example:mystery 1.0: its POM declares "BSD License", which FXM doesn\'t recognize as one licence. Read the library\'s licence, and if FXM may ship it, add a review to REVIEWED_LIBRARIES (apps/mobile/scripts/notices.ts)',
    ])
    const reviewed = notices({
      report: report({ libraries: [unknown] }),
      reviewed: {
        'org.example:mystery': {
          licence: 'BSD-3-Clause',
          declared: ['BSD License'],
          reason: 'LICENSE in its repository: the 3-clause BSD licence (read 2026-10-26)',
          notice: 'Copyright (c) 2026, Example\nAll rights reserved.',
        },
      },
    })
    expect(reviewed.problems).toEqual([])
    expect(reviewed.text).toContain('org.example:mystery 1.0\nLicence: BSD-3-Clause')
    expect(reviewed.text).toContain('Copyright (c) 2026, Example')
  })

  it('refuses a library without any licence in its POM', () => {
    const none = library({ group: 'org.example', name: 'silent', version: '2.0', licences: [] })
    expect(notices({ report: report({ libraries: [none] }) }).problems[0]).toContain(
      'org.example:silent 2.0: its POM declares no licence.',
    )
  })

  it('asks for a new review when the POM no longer declares what was reviewed', () => {
    const changed = library({
      group: 'org.example',
      name: 'moved',
      version: '3.0',
      licences: [{ name: 'Custom licence', url: '' }],
    })
    const { problems } = notices({
      report: report({ libraries: [changed] }),
      reviewed: {
        'org.example:moved': {
          licence: 'MIT',
          declared: ['MIT'],
          reason: 'read',
          notice: 'Copyright Example',
        },
      },
    })
    expect(problems).toEqual([
      'org.example:moved 3.0: its POM now declares "Custom licence", not "MIT" as when it was reviewed: review it again and update REVIEWED_LIBRARIES (apps/mobile/scripts/notices.ts)',
    ])
  })

  it('refuses a licence FXM doesn’t ship in the APK, even after a review', () => {
    const gpl = library({
      group: 'org.example',
      name: 'copyleft',
      version: '1.0',
      licences: [{ name: 'GPL', url: '' }],
    })
    const { problems } = notices({
      report: report({ libraries: [gpl] }),
      reviewed: {
        'org.example:copyleft': { licence: 'GPL-2.0-only', declared: ['GPL'], reason: 'read' },
      },
    })
    expect(problems).toEqual([
      "org.example:copyleft 1.0 is under GPL-2.0-only, which FXM doesn't ship in the APK (ACCEPTED_LICENCES in apps/mobile/scripts/notices.ts)",
    ])
  })

  it('needs the copyright notice of a licence other than the Apache 2.0', () => {
    const mit = library({
      group: 'org.example',
      name: 'tiny',
      version: '1.0',
      licences: [{ name: 'MIT License', url: '' }],
    })
    expect(notices({ report: report({ libraries: [mit] }) }).problems).toEqual([
      "org.example:tiny 1.0 is under MIT, whose terms ask for the library's copyright notice, but it ships no licence file: add its notice to a review in REVIEWED_LIBRARIES (apps/mobile/scripts/notices.ts)",
    ])
    const shipped = library({
      ...mit,
      notices: [{ path: 'META-INF/LICENSE', text: 'MIT License\n\nCopyright (c) 2026 Tiny' }],
    })
    const result = notices({ report: report({ libraries: [shipped] }) })
    expect(result.problems).toEqual([])
    expect(result.text).toContain('Copyright (c) 2026 Tiny')
  })

  it('refuses prebuilt code in FXM’s own projects, which the report can’t attribute', () => {
    const input = report()
    mkdirSync(join(input.app, 'libs'), { recursive: true })
    writeFileSync(join(input.app, 'libs', 'vendor.jar'), 'PK')
    const plugins = join(root, 'apps/mobile/android/capacitor-cordova-android-plugins')
    mkdirSync(join(plugins, 'src/main/libs'), { recursive: true })
    writeFileSync(join(plugins, 'src/main/libs/plugin.aar'), 'PK')
    const { problems } = notices({
      report: {
        ...input,
        projects: [...input.projects, { path: ':capacitor-cordova-android-plugins', dir: plugins }],
      },
    })
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain(join('apps/mobile/android/app', 'libs', 'vendor.jar'))
    expect(problems[1]).toContain(
      join('capacitor-cordova-android-plugins', 'src/main/libs', 'plugin.aar'),
    )
  })

  it('refuses a project that is neither FXM’s own nor in an npm package', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'fxm-elsewhere-'))
    try {
      const { problems } = notices({
        report: report({ projects: [{ path: ':vendor', dir: elsewhere }] }),
      })
      expect(problems).toEqual([
        `the Android project :vendor (${elsewhere}) is neither FXM's own nor in an npm package`,
      ])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('refuses an npm package without an accepted licence or a licence file', () => {
    const input = report()
    const pkg = dirname(input.projects[0]?.dir ?? '')
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@capacitor/android', version: '8.5.3', license: 'SSPL-1.0' }),
    )
    expect(notices({ report: input }).problems).toEqual([
      "@capacitor/android 8.5.3 (the Android project :capacitor-android) is under SSPL-1.0, which FXM doesn't ship in the APK",
    ])
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@capacitor/android', version: '8.5.3', license: 'MIT' }),
    )
    rmSync(join(pkg, 'LICENSE'))
    expect(notices({ report: input }).problems).toEqual([
      '@capacitor/android 8.5.3 (the Android project :capacitor-android) ships no licence file',
    ])
  })

  it('needs make dist’s notices, and at least one library', () => {
    const { problems } = notices({ report: report({ libraries: [] }), web: 'Something else' })
    expect(problems).toEqual([
      `the web notices don't start with "${WEB_NOTICES_TITLE}": pass make dist's dist/pages/${NOTICES_FILE}`,
      'the library report lists no library with files',
    ])
  })
})

describe('the release build', () => {
  const releaseApk = read('release-apk.sh')

  it('checks every APK for the notices this module writes', () => {
    expect(releaseApk).toContain(`\nAPK_NOTICES=${APK_NOTICES_PATH}\n`)
    expect(releaseApk).toContain(`\nNOTICES_TITLE='${NOTICES_TITLE}'\n`)
    expect(releaseApk).toContain(`\nWEB_NOTICES_TITLE='${WEB_NOTICES_TITLE}'\n`)
    expect(APK_NOTICES_PATH).toBe(`assets/public/${NOTICES_FILE}`)
  })

  it('writes them from Gradle’s report and make dist’s notices before Gradle builds the APKs', () => {
    const gradle = read('../android/app/libraries.gradle')
    expect(gradle).toContain("tasks.register('fxmLibraryReport')")
    expect(gradle).toContain("layout.buildDirectory.file('fxm/android-libraries.json')")
    expect(gradle).toContain("configurations.named('releaseRuntimeClasspath')")
    expect(read('../android/app/build.gradle')).toMatch(/^apply from: 'libraries\.gradle'$/m)
    expect(releaseApk).toContain('local report=android/app/build/fxm/android-libraries.json')
    expect(releaseApk).toContain(`local notices=android/app/src/main/${APK_NOTICES_PATH}`)
    const steps = [
      'pnpm --silent --filter @fxm/deploy dist',
      'pnpm --filter @fxm/mobile cap sync android',
      './gradlew --no-daemon fxmLibraryReport',
      'scripts/write-notices.ts',
      './gradlew --no-daemon -PfxmReleaseApks assembleRelease',
    ]
    const at = steps.map((step) => releaseApk.indexOf(step))
    expect(at.every((index) => index > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('takes make dist’s title and repository from its notices', () => {
    const licenses = read('../../../scripts/build-dist/src/licenses.ts')
    expect(licenses).toContain(`'${WEB_NOTICES_TITLE}',`)
    expect(read('../../../scripts/build-dist/src/paths.ts')).toContain(
      `export const REPOSITORY_URL = '${REPOSITORY_URL}'`,
    )
  })

  it('serves them where the app’s notices page reads them', () => {
    const page = read('../../web/src/features/settings/notices.ts')
    expect(page).toContain(`export const BUNDLED_NOTICES_FILE = '${NOTICES_FILE}'`)
    expect(page).toContain(`export const BUNDLED_NOTICES_TITLE = '${NOTICES_TITLE}'`)
  })

  it('keeps every review complete: an accepted licence, its reason, and a notice beyond the Apache 2.0', () => {
    for (const [key, review] of Object.entries(REVIEWED_LIBRARIES)) {
      expect(ACCEPTED_LICENCES.has(review.licence), key).toBe(true)
      expect(review.reason, key).not.toBe('')
      if (review.licence !== 'Apache-2.0') expect(review.notice, key).toBeTruthy()
    }
  })
})
