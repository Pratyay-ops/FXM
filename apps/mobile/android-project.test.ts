import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('the Android project', () => {
  it('compiles against the SDK platform that make android-setup installs', () => {
    const compileSdk = /compileSdkVersion = (\d+)/.exec(read('android/variables.gradle'))?.[1]
    expect(compileSdk).toBeDefined()
    expect(read('../../scripts/android-setup.sh')).toContain(`\nSDK_PLATFORM=${compileSdk}\n`)
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

  it('runs the Capacitor CLI non-interactively, so it sends no telemetry', () => {
    // In a terminal, `cap` turns on its opt-out telemetry and stores a machine id in your home
    // folder; CI=1 makes it non-interactive.
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts.cap).toBe('CI=1 cap')
  })
})
