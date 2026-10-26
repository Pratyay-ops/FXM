import { FXM_SPOTIFY_LOGIN_ERROR_CODES, HOST_CLASSES, HOST_RULES } from '@fxm/platform'
import { describe, expect, it } from 'vitest'
import {
  KOTLIN_HOST_CLASSES,
  kotlinLoginTables,
  kotlinPlatformTables,
  kotlinString,
  LOGIN_TABLES_PATH,
  PLATFORM_TABLES_PATH,
} from './native-tables.ts'

describe('the tables native code shares with @fxm/platform', () => {
  it('are generated from the platform package', async () => {
    // The native plugin enforces the same host table as the transports. After a change to
    // packages/platform/src/hosts.ts or android-http.ts, regenerate the Kotlin file with
    // `scripts/run.sh pnpm vitest run apps/mobile/scripts -u`.
    await expect(kotlinPlatformTables()).toMatchFileSnapshot(`../${PLATFORM_TABLES_PATH}`)
  })

  it('name every host class in Kotlin', () => {
    expect(Object.keys(KOTLIN_HOST_CLASSES).sort()).toEqual([...HOST_CLASSES].sort())
  })

  it('list every host, with its path prefix', () => {
    const kotlin = kotlinPlatformTables()
    for (const rule of HOST_RULES) expect(kotlin).toContain(kotlinString(rule.host))
    expect(kotlin).toContain('pathPrefix = "/player/station/"')
  })

  it('write Kotlin string literals that cannot start a template', () => {
    expect(kotlinString('a"b\\c$d')).toBe('"a\\"b\\\\c\\$d"')
    const long = kotlinPlatformTables([
      { host: 'a.example', hostClass: 'open', service: 'x'.repeat(90), pathPrefix: '/p/' },
    ])
    expect(long).toContain('    HostRule(\n      "a.example",\n')
  })
})

describe('the tables the Spotify login shares with @fxm/platform', () => {
  it('are generated from the platform package', async () => {
    // Both sides of the FxmSpotifyLogin bridge use the same codes, rate limit and allow-list.
    // After a change to packages/platform/src/android-spotify-login.ts, regenerate the Kotlin
    // file with `scripts/run.sh pnpm vitest run apps/mobile/scripts -u`.
    await expect(kotlinLoginTables()).toMatchFileSnapshot(`../${LOGIN_TABLES_PATH}`)
  })

  it('name every error code and every token parameter, in the order they are sent', () => {
    const kotlin = kotlinLoginTables()
    for (const code of FXM_SPOTIFY_LOGIN_ERROR_CODES) expect(kotlin).toContain(`  ${code},\n`)
    const order = ['reason', 'productType', 'totp', 'totpServer', 'totpVer'].map((name) =>
      kotlin.indexOf(`"${name}" to Regex(`),
    )
    expect(order.every((index) => index > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // A Kotlin template would turn the end anchor into an interpolation.
    expect(kotlin).toContain('Regex("^[0-9]{1,4}\\$")')
  })
})
