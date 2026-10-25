import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const envScript = fileURLToPath(new URL('../../scripts/env.sh', import.meta.url))

// Every script and make target sources scripts/env.sh from bash, and developers source it from
// their own shell, often zsh. CI images may not have zsh.
const shells = ['bash', 'zsh'].flatMap((name) => {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const path = dirs.map((dir) => join(dir, name)).find((candidate) => existsSync(candidate))
  return path ? [{ name, path }] : []
})

// A main checkout with the Android tools installed: the adb wrapper that make android-setup
// writes into .tools/bin, and the SDK's own adb, which ignores ANDROID_USER_HOME.
let home = ''
const tool = (path: string) => join(home, '.tools', path)

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'fxm-env-'))
  for (const dir of ['bin', 'jdk/bin', 'android-sdk/cmdline-tools/latest/bin']) {
    mkdirSync(tool(dir), { recursive: true })
  }
  mkdirSync(tool('android-sdk/platform-tools'))
  for (const adb of ['bin/adb', 'android-sdk/platform-tools/adb']) {
    writeFileSync(tool(adb), '#!/bin/sh\nexit 1\n')
    chmodSync(tool(adb), 0o755)
  }
})

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true })
})

/** Sources env.sh `times` times with the given PATH and reports the PATH and adb it ends with. */
function sourceEnv(shell: string, path: string[], times = 1) {
  const script = `${'. "$1"; '.repeat(times)}printf '%s\\n' "$PATH"; command -v adb`
  const output = execFileSync(
    shell,
    [...(shell.endsWith('zsh') ? ['-f'] : []), '-c', script, 'sh', envScript],
    {
      cwd: home,
      // Outside a git checkout, env.sh keeps the FXM_HOME it inherits.
      env: {
        FXM_HOME: home,
        HOME: home,
        PATH: path.join(':'),
        GIT_CEILING_DIRECTORIES: dirname(home),
      },
      encoding: 'utf8',
    },
  )
  const [finalPath = '', adb] = output.trimEnd().split('\n')
  return { path: finalPath.split(':'), adb }
}

describe.each(shells)('scripts/env.sh in $name', ({ path: shell }) => {
  it('puts .tools/bin, and with it the adb wrapper, first on a PATH that already has it', () => {
    // The shell sourced env.sh before make android-setup, so .tools/bin is on its PATH already,
    // but the JDK and SDK folders are not.
    const { path, adb } = sourceEnv(shell, ['/usr/bin', tool('bin'), '/bin'])
    expect(path).toEqual([
      tool('bin'),
      tool('jdk/bin'),
      tool('android-sdk/cmdline-tools/latest/bin'),
      tool('android-sdk/platform-tools'),
      '/usr/bin',
      '/bin',
    ])
    expect(adb).toBe(tool('bin/adb'))
  })

  it('keeps a single copy of each folder however often it is sourced', () => {
    const start = [tool('bin'), tool('bin'), '/usr/bin', tool('android-sdk/platform-tools'), '/bin']
    const once = sourceEnv(shell, start)
    expect(sourceEnv(shell, start, 3)).toEqual(once)
    expect(once.path).toEqual([
      tool('bin'),
      tool('jdk/bin'),
      tool('android-sdk/cmdline-tools/latest/bin'),
      tool('android-sdk/platform-tools'),
      '/usr/bin',
      '/bin',
    ])
  })
})
