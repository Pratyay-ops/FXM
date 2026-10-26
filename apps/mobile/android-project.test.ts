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

  it('builds FXM’s native HTTP into the app and registers its plugins before the bridge starts', () => {
    expect(read('android/settings.gradle')).toMatch(/^include ':fxm-http'$/m)
    expect(read('android/app/build.gradle')).toContain("implementation project(':fxm-http')")
    const activity = withoutComments(
      read('android/app/src/main/java/io/github/pratyayops/fxm/MainActivity.java'),
    )
    for (const plugin of ['FxmHttpPlugin', 'DisabledCapacitorHttp']) {
      const register = activity.indexOf(`registerPlugin(${plugin}.class)`)
      expect(register, plugin).toBeGreaterThan(-1)
      expect(register, plugin).toBeLessThan(activity.indexOf('super.onCreate'))
    }
  })

  it('replaces Capacitor’s own CapacitorHttp plugin with one that refuses every call', () => {
    // The bridge registers CapacitorHttp whatever capacitor.config.ts says, and its methods reach
    // any URL with the WebView's cookies. The app's plugins replace built-in ones of the same name.
    const builtIn = read(
      'node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/CapacitorHttp.java',
    )
    expect(builtIn).toMatch(/^public class CapacitorHttp extends Plugin \{$/m)
    const builtInMethods = [...builtIn.matchAll(/@PluginMethod\s+public void (\w+)\(/g)]
    expect(builtInMethods.length).toBeGreaterThan(3)
    const stub = withoutComments(
      read(
        'android/fxm-http/src/main/kotlin/io/github/pratyayops/fxm/http/DisabledCapacitorHttp.kt',
      ),
    )
    expect(stub).toMatch(/@CapacitorPlugin\(name = DisabledCapacitorHttp\.NAME\)/)
    expect(stub).toContain('const val NAME = "CapacitorHttp"')
    for (const [, method] of builtInMethods) {
      expect(stub, method).toContain(`@PluginMethod fun ${method}(call: PluginCall) = refuse(call)`)
    }
    expect(stub).toContain('private fun refuse(call: PluginCall) = call.unavailable(MESSAGE)')
  })

  it('gives native code no HTTP stack that shares the WebView’s cookies', () => {
    // Capacitor's process-wide cookie handler makes every HttpURLConnection send and store the
    // WebView's cookies: CapacitorHttp and Media3's DefaultHttpDataSource included.
    const files = [
      ...sources('android/fxm-http/src/main', ['.kt', '.java']),
      ...sources('android/fxm-player/src/main', ['.kt', '.java']),
      ...sources('android/app/src/main/java', ['.kt', '.java']),
    ]
    expect(files.length).toBeGreaterThan(15)
    for (const file of files) {
      expect(withoutComments(read(file)), file).not.toMatch(
        /HttpURLConnection|openConnection\(|com\.getcapacitor\.plugin\.|HttpRequestHandler|DefaultHttpDataSource|JavaNetCookieJar/,
      )
    }
  })

  describe('the native player (fxm-player)', () => {
    const player = (path: string) => read(`android/fxm-player/${path}`)
    const kotlin = (name: string) =>
      player(`src/main/kotlin/io/github/pratyayops/fxm/player/${name}`)

    it('is built into the app, and its plugin registered before the bridge starts', () => {
      expect(read('android/settings.gradle')).toMatch(/^include ':fxm-player'$/m)
      expect(read('android/app/build.gradle')).toContain("implementation project(':fxm-player')")
      const activity = read('android/app/src/main/java/io/github/pratyayops/fxm/MainActivity.java')
      const register = activity.indexOf('registerPlugin(FxmPlayerPlugin.class)')
      expect(register).toBeGreaterThan(-1)
      expect(register).toBeLessThan(activity.indexOf('super.onCreate'))
    })

    it('runs Media3 in a mediaPlayback foreground service that only FXM can bind', () => {
      const manifest = player('src/main/AndroidManifest.xml')
      const service = /<service[\s\S]*?<\/service>/.exec(manifest)?.[0] ?? ''
      expect(service).toContain('android:name=".PlaybackService"')
      expect(service).toContain('android:exported="false"')
      expect(service).toContain('android:foregroundServiceType="mediaPlayback"')
      for (const permission of [
        'FOREGROUND_SERVICE',
        'FOREGROUND_SERVICE_MEDIA_PLAYBACK',
        'WAKE_LOCK',
      ]) {
        expect(manifest).toContain(
          `<uses-permission android:name="android.permission.${permission}" />`,
        )
      }
    })

    it('fetches audio and artwork through fxm-http’s shared client', () => {
      const gradle = player('build.gradle')
      expect(gradle).toContain("implementation project(':fxm-http')")
      for (const module of ['exoplayer', 'session', 'datasource-okhttp']) {
        expect(gradle).toContain(`"androidx.media3:media3-${module}:$media3Version"`)
      }
      expect(read('android/variables.gradle')).toMatch(/^ {4}media3Version = '\d+\.\d+\.\d+'$/m)
      const service = withoutComments(kotlin('PlaybackService.kt'))
      expect(service.match(/OkHttpDataSource\.Factory\(client\)/g)).toHaveLength(2)
      expect(service).toContain('val client = FxmHttp.client(this)')
      expect(service).toContain('.setBitmapLoader(')
      expect(service).toContain('.setWakeMode(C.WAKE_MODE_NETWORK)')
    })

    it('keeps the app alive when the WebView’s renderer dies', () => {
      const plugin = withoutComments(kotlin('FxmPlayerPlugin.kt'))
      expect(plugin).toContain('bridge.addWebViewListener(renderer)')
      expect(plugin).toMatch(/onRenderProcessGone[\s\S]*?return true/)
    })

    it('speaks the same messages as @fxm/player', () => {
      const ts = read('../../packages/player/src/native/plugin.ts')
      const messages = kotlin('PlayerMessages.kt')
      expect(kotlin('FxmPlayerPlugin.kt')).toContain(
        `const val NAME = "${/FXM_PLAYER_PLUGIN = '(\w+)'/.exec(ts)?.[1]}"`,
      )
      expect(messages).toContain(
        `const val MAX_UPCOMING = ${/FXM_PLAYER_MAX_UPCOMING = (\d+)/.exec(ts)?.[1]}`,
      )
      expect(messages).toContain(
        `const val MAX_ENTRY_DATA_CHARS = ${/FXM_PLAYER_MAX_ENTRY_DATA = ([\d_]+)/.exec(ts)?.[1]}`,
      )
      const codes = /FXM_PLAYER_ERROR_CODES = \[([^\]]+)\]/.exec(ts)?.[1] ?? ''
      for (const code of codes.match(/'\w+'/g) ?? []) {
        expect(kotlin('FxmPlayerPlugin.kt')).toContain(`= "${code.slice(1, -1)}"`)
      }
      const events = kotlin('Events.kt')
      for (const wire of ['auto', 'repeat', 'skip', 'expiring', 'network', 'next', 'previous']) {
        expect(events).toContain(`("${wire}")`)
      }
      for (const event of ['state', 'transition', 'error', 'request', 'command', 'network']) {
        expect(messages).toContain(`"${event}" to`)
      }
    })

    it('runs the same audio effects as the web app (stage 8.1)', () => {
      const ts = read('../../packages/player/src/native/plugin.ts')
      const core = read('../../packages/core/src/effects/equalizer.ts')
      const loudness = read('../../packages/core/src/effects/loudness.ts')
      const effects = kotlin('Effects.kt')
      const bands = (
        /EQUALIZER_BANDS_HZ[^=]*=\s*Object\.freeze\(\[([^\]]+)\]/.exec(core)?.[1] ?? ''
      )
        .split(',')
        .map((band) => Number(band.trim()))
        .filter((band) => band > 0)
      const kotlinBands = (/val HZ: List<Double> = listOf\(([^)]+)\)/.exec(effects)?.[1] ?? '')
        .split(',')
        .map((band) => Number(band.trim()))
      expect(bands).toHaveLength(10)
      expect(kotlinBands).toEqual(bands)
      expect(effects).toContain(
        `const val MAX_CUT_DB = ${/MAX_LOUDNESS_CUT_DB = (\d+)/.exec(loudness)?.[1]}.0`,
      )
      // The plugin's optional methods and event, on both sides.
      for (const method of ['setEffects', 'setSleepTimer']) {
        expect(ts).toContain(`${method}?(options`)
        expect(kotlin('FxmPlayerPlugin.kt')).toContain(`fun ${method}(call: PluginCall)`)
      }
      expect(ts).toMatch(/sleep: \{ readonly reason: 'timer' \| 'end-of-track' \}/)
      expect(kotlin('Events.kt')).toContain('("timer")')
      expect(kotlin('Events.kt')).toContain('("end-of-track")')
      expect(kotlin('PlayerMessages.kt')).toContain('"sleep" to')
      // The equalizer runs in Media3's audio sink, on every stream.
      expect(kotlin('PlaybackService.kt')).toContain('.setAudioProcessors(arrayOf(equalizer))')
    })
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
