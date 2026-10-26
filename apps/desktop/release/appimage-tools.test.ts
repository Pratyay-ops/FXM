import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Reporter } from './actions.ts'
import {
  type AppImageArch,
  type AppImageTool,
  appImageArch,
  appImageTools,
  BUNDLER_FILES,
  checkTauriCli,
  fetchAppImageTools,
  readTauriCliVersion,
  TAURI_CLI,
  unexpectedTools,
} from './appimage-tools.ts'
import { main } from './release.ts'
import { TARGETS } from './targets.ts'
import { temporaryFolder } from './testing.ts'

const ARCHES: readonly AppImageArch[] = ['x86_64', 'aarch64']

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** Tools made up for a test, whose bytes are their URL: two tools, then the runtime. */
function madeUpTools(): [AppImageTool, AppImageTool, AppImageTool] {
  const tool = (name: string, runtime: boolean): AppImageTool => {
    const url = `https://example.org/${name}`
    return { name, url, sha256: sha256(url), runtime }
  }
  return [tool('tool-a', false), tool('tool-b', false), tool('rt', true)]
}

/** A download that serves each URL's own text, and records what was asked. */
function fakeDownload() {
  const asked: string[] = []
  return {
    asked,
    download: async (url: string) => {
      asked.push(url)
      return new TextEncoder().encode(url)
    },
  }
}

function recorder() {
  const lines: string[] = []
  const reporter: Reporter = {
    info: (m) => lines.push(`info ${m}`),
    notice: (t, m) => lines.push(`notice ${t}: ${m}`),
    error: (t, m) => lines.push(`error ${t}: ${m}`),
    output: (n, v) => lines.push(`output ${n}=${v}`),
    summary: (m) => lines.push(`summary ${m}`),
  }
  return { lines, reporter }
}

let folder: string
beforeEach(() => {
  folder = temporaryFolder('appimage-tools')
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

describe('the pinned AppImage tools', () => {
  it('are the files the bundler of the Tauri CLI 2.12.2 looks for, and the runtime', () => {
    for (const arch of ARCHES) {
      expect(appImageTools(arch).map((tool) => tool.name)).toEqual([
        `AppRun-${arch}`,
        `linuxdeploy-07333c6-${arch}.AppImage`,
        'linuxdeploy-plugin-appimage.AppImage',
        `appimage-runtime-${arch}`,
      ])
    }
  })

  it('come from GitHub releases that are not rebuilt, each with its SHA-256', () => {
    for (const arch of ARCHES) {
      for (const tool of appImageTools(arch)) {
        expect(tool.url).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\//)
        expect(tool.url).not.toMatch(/\/(continuous|latest)\//)
        expect(tool.url.endsWith(`-${arch}`) || tool.url.endsWith(`-${arch}.AppImage`)).toBe(true)
        expect(tool.sha256).toMatch(/^[0-9a-f]{64}$/)
      }
    }
    const hashes = ARCHES.flatMap((arch) => appImageTools(arch).map((tool) => tool.sha256))
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('give the build exactly one runtime, which nothing runs', () => {
    for (const arch of ARCHES) {
      expect(appImageTools(arch).filter((tool) => tool.runtime)).toHaveLength(1)
      // linuxdeploy runs any executable linuxdeploy-plugin-* it finds next to itself.
      const runtime = appImageTools(arch).find((tool) => tool.runtime)
      expect(runtime?.name).not.toMatch(/^linuxdeploy-plugin-/)
    }
  })

  it('cover every Linux target of the release', () => {
    const linux = TARGETS.filter((target) => target.bundles.includes('appimage'))
    expect(linux.map((target) => appImageArch(target.triple))).toEqual(['x86_64', 'aarch64'])
    expect(() => appImageArch('armv7-unknown-linux-gnueabihf')).toThrow(/No AppImage tools/)
  })

  it('are pinned for the Tauri CLI that apps/desktop installs', () => {
    // After an update of @tauri-apps/cli, compare its bundler's prepare_tools with
    // appimage-tools.ts (README, "Maintenance"), then update TAURI_CLI.
    expect(readTauriCliVersion()).toBe(TAURI_CLI)
    expect(() => checkTauriCli(TAURI_CLI)).not.toThrow()
    expect(() => checkTauriCli('2.13.0')).toThrow(/pinned for the Tauri CLI 2\.12\.2, but 2\.13\.0/)
  })
})

describe('fetching them', () => {
  it('writes each checked file under its name, the tools executable, and returns the runtime', async () => {
    const { asked, download } = fakeDownload()
    const out = join(folder, 'target', '.tauri')
    const tools = madeUpTools()
    const { runtimeFile, files } = await fetchAppImageTools({ out, tools, download })
    expect(asked).toEqual(tools.map((tool) => tool.url))
    expect(readdirSync(out).sort()).toEqual(['rt', 'tool-a', 'tool-b'])
    expect(readFileSync(join(out, 'tool-a'), 'utf8')).toBe('https://example.org/tool-a')
    expect(statSync(join(out, 'tool-a')).mode & 0o777).toBe(0o755)
    expect(statSync(join(out, 'rt')).mode & 0o777).toBe(0o644)
    expect(runtimeFile).toBe(join(out, 'rt'))
    expect(files.map((file) => file.name)).toEqual(['tool-a', 'tool-b', 'rt'])
  })

  it('writes nothing when any file differs from its SHA-256', async () => {
    const { download } = fakeDownload()
    const out = join(folder, 'tools')
    const [first, second, runtime] = madeUpTools()
    const changed = { ...runtime, sha256: sha256('what was pinned') }
    await expect(
      fetchAppImageTools({ out, tools: [first, second, changed], download }),
    ).rejects.toThrow(/example\.org\/rt has SHA-256 [0-9a-f]{64}, not [0-9a-f]{64}/)
    expect(existsSync(out)).toBe(false)
  })

  it('replaces a file of the same name that is already there', async () => {
    const { download } = fakeDownload()
    const out = join(folder, 'tools')
    mkdirSync(out)
    writeFileSync(join(out, 'tool-a'), 'something else')
    await fetchAppImageTools({ out, tools: madeUpTools(), download })
    expect(readFileSync(join(out, 'tool-a'), 'utf8')).toBe('https://example.org/tool-a')
  })

  it('needs exactly one runtime', async () => {
    const { download } = fakeDownload()
    const tools = madeUpTools().map((tool) => ({ ...tool, runtime: false }))
    await expect(fetchAppImageTools({ out: folder, tools, download })).rejects.toThrow(
      /exactly one runtime/,
    )
  })

  it('refuses the pinned tools when the release files changed, in the workflow step', async () => {
    const { download } = fakeDownload()
    const out = join(folder, 'tools')
    const { lines, reporter } = recorder()
    const args = ['appimage-tools', '--triple', 'x86_64-unknown-linux-gnu', '--out', out]
    await expect(main(args, {}, reporter, { download })).rejects.toThrow(
      /AppRun-x86_64 has SHA-256 [0-9a-f]{64}, not f30140a4/,
    )
    expect(existsSync(out)).toBe(false)
    expect(lines).toEqual([])
  })
})

describe('after the build', () => {
  const placeTools = (arch: AppImageArch) => {
    for (const name of [...appImageTools(arch).map((tool) => tool.name), ...BUNDLER_FILES]) {
      writeFileSync(join(folder, name), '')
    }
  }

  it('finds nothing but the pinned files and the bundler’s own scripts', async () => {
    placeTools('aarch64')
    expect(unexpectedTools(folder, appImageTools('aarch64'))).toEqual([])
    const { lines, reporter } = recorder()
    const args = ['appimage-tools', '--triple', 'aarch64-unknown-linux-gnu', '--out', folder]
    await main([...args, '--after-build'], {}, reporter)
    expect(lines).toEqual(['info The aarch64 AppImage was built with the checked tools only.'])
  })

  it('stops the job when the bundler fetched a tool itself', async () => {
    placeTools('x86_64')
    writeFileSync(join(folder, 'linuxdeploy-abcdef0-x86_64.AppImage'), '')
    expect(unexpectedTools(folder, appImageTools('x86_64'))).toEqual([
      'linuxdeploy-abcdef0-x86_64.AppImage',
    ])
    const { reporter } = recorder()
    const args = ['appimage-tools', '--triple', 'x86_64-unknown-linux-gnu', '--out', folder]
    await expect(main([...args, '--after-build'], {}, reporter)).rejects.toThrow(
      /fetched tools of its own, unchecked: linuxdeploy-abcdef0-x86_64\.AppImage/,
    )
  })
})
