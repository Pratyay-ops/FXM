import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const local = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/** The source files under `dir` (relative to this file) whose names end in one of `extensions`. */
function sources(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(local(dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => extensions.some((extension) => file.endsWith(extension)))
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .map((file) => join(dir, file))
}

/** Code without its comments, which may name what the code must not use. */
const withoutComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the Android project', () => {
  it('compiles against the SDK platform that make android-setup installs', () => {
    const compileSdk = /compileSdkVersion = (\d+)/.exec(read('android/variables.gradle'))?.[1]
    expect(compileSdk).toBeDefined()
    expect(read('../../scripts/android-setup.sh')).toContain(`\nSDK_PLATFORM=${compileSdk}\n`)
  })

  it('builds the installed @capacitor/android', () => {
    // `cap sync` (make apk) and `cap update` write the path into pnpm's store, which names the
    // Capacitor versions, so the committed file goes stale when Capacitor is upgraded.
    const settings = read('android/capacitor.settings.gradle')
    const project = /^project\(':capacitor-android'\)\.projectDir = new File\('(.+)'\)$/m
    const dir = project.exec(settings)?.[1]
    expect(dir).toBeDefined()
    const committed = resolve(local('android'), dir ?? '', '..')
    expect(
      existsSync(committed) ? realpathSync(committed) : committed,
      'Run `scripts/run.sh pnpm --filter @fxm/mobile cap update android` and commit ' +
        'android/capacitor.settings.gradle',
    ).toBe(realpathSync(local('node_modules/@capacitor/android')))
  })

  it('verifies the Gradle distribution that the wrapper downloads', () => {
    const wrapper = read('android/gradle/wrapper/gradle-wrapper.properties')
    expect(wrapper).toMatch(/^distributionSha256Sum=[0-9a-f]{64}$/m)
    expect(wrapper).toMatch(
      /^distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-[\d.]+-bin\.zip$/m,
    )
  })

  it('keeps app data out of backups and device-to-device transfers', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml')
    expect(manifest).toContain('android:allowBackup="false"')
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"')
    const rules = read('android/app/src/main/res/xml/data_extraction_rules.xml')
    const domains = ['root', 'file', 'database', 'sharedpref', 'external']
    const deviceDomains = ['device_root', 'device_file', 'device_database', 'device_sharedpref']
    for (const section of ['cloud-backup', 'device-transfer']) {
      const body = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(rules)?.[1] ?? ''
      for (const domain of [...domains, ...deviceDomains]) {
        expect(body).toContain(`<exclude domain="${domain}" path="." />`)
      }
    }
  })

  it('draws dark system bars with light icons before the web app takes over', () => {
    const styles = read('android/app/src/main/res/values/styles.xml')
    for (const item of ['statusBarColor', 'navigationBarColor', 'windowBackground']) {
      expect(styles).toContain(`<item name="android:${item}">@color/fxm_background</item>`)
    }
    expect(styles).toContain('<item name="android:windowLightStatusBar">false</item>')
    expect(styles).toContain(
      '<item name="windowSplashScreenBackground">@color/fxm_background</item>',
    )
  })

  it('builds FXM’s native HTTP into the app and registers its plugin before the bridge starts', () => {
    expect(read('android/settings.gradle')).toMatch(/^include ':fxm-http'$/m)
    expect(read('android/app/build.gradle')).toContain("implementation project(':fxm-http')")
    const activity = read('android/app/src/main/java/io/github/pratyayops/fxm/MainActivity.java')
    const register = activity.indexOf('registerPlugin(FxmHttpPlugin.class)')
    expect(register).toBeGreaterThan(-1)
    expect(register).toBeLessThan(activity.indexOf('super.onCreate'))
  })

  it('gives native code no HTTP stack that shares the WebView’s cookies', () => {
    // Capacitor's process-wide cookie handler makes every HttpURLConnection send and store the
    // WebView's cookies: CapacitorHttp and Media3's DefaultHttpDataSource included.
    const files = [
      ...sources('android/fxm-http/src/main', ['.kt', '.java']),
      ...sources('android/app/src/main/java', ['.kt', '.java']),
    ]
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      expect(withoutComments(read(file)), file).not.toMatch(
        /HttpURLConnection|openConnection\(|CapacitorHttp|DefaultHttpDataSource|JavaNetCookieJar/,
      )
    }
  })

  it('never lets the web app’s code call CapacitorHttp', () => {
    for (const file of [
      ...sources('../../packages/platform/src', ['.ts']),
      ...sources('../web/src', ['.ts', '.tsx']),
    ]) {
      expect(withoutComments(read(file)), file).not.toMatch(/CapacitorHttp\b(?!WebFetch)/)
    }
  })

  it('builds OkHttp and its MockWebServer from one release', () => {
    const gradle = read('android/fxm-http/build.gradle')
    expect(gradle).toContain('"com.squareup.okhttp3:okhttp:$okhttpVersion"')
    expect(gradle).toContain('"com.squareup.okhttp3:mockwebserver3:$okhttpVersion"')
    expect(read('android/variables.gradle')).toMatch(/^ {4}okhttpVersion = '\d+\.\d+\.\d+'$/m)
  })

  describe('the cap script', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    const cap = pkg.scripts.cap ?? ''

    it('runs the Capacitor CLI non-interactively, so it sends no telemetry', () => {
      // In a terminal, `cap` turns on its opt-out telemetry and stores a machine id in your home
      // folder; CI=1 makes it non-interactive.
      expect(cap).toMatch(/^CI=1 .* cap$/)
    })

    it('loads capacitor.config.ts on every Node 22 release the repo accepts', () => {
      // TypeScript 7 has no transpileModule, so the CLI imports the config through Node's type
      // stripping, which Node 22 turns on by default only from 22.18. The root engines field
      // accepts 22.13 and later.
      expect(cap).toContain(
        'NODE_OPTIONS="--experimental-strip-types --disable-warning=ExperimentalWarning $NODE_OPTIONS"',
      )
    })
  })
})
