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
  checkAfterBuild,
  checkTauriCli,
  embedsRuntime,
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
  /** A made-up runtime: 64 bytes, as its tool entry pins them. */
  const RUNTIME = Uint8Array.from({ length: 64 }, (_, index) => (index * 37) % 251)
  const runtimeTool: AppImageTool = {
    name: 'rt',
    url: 'https://example.org/rt',
    sha256: createHash('sha256').update(RUNTIME).digest('hex'),
    runtime: true,
  }
  const tools = [...madeUpTools().slice(0, 2), runtimeTool]
  const out = () => join(folder, 'tools')
  const bundleDir = () => join(folder, 'bundle')

  /** The tools folder and the bundle folder after a build, with one AppImage of `head`. */
  function placeBuild(head: Uint8Array) {
    mkdirSync(out())
    for (const name of [...tools.map((tool) => tool.name), ...BUNDLER_FILES]) {
      writeFileSync(join(out(), name), name === 'rt' ? RUNTIME : '')
    }
    mkdirSync(join(bundleDir(), 'appimage'), { recursive: true })
    const squashfs = new TextEncoder().encode('hsqs and the rest of the image')
    writeFileSync(
      join(bundleDir(), 'appimage', 'FXM_1.0.0_amd64.AppImage'),
      Buffer.concat([head, squashfs]),
    )
  }

  /** The runtime with the bytes from `start` up to `end` changed, as appimagetool's digest. */
  function withDigest(start: number, end: number) {
    const head = RUNTIME.slice()
    for (let index = start; index < end; index++) head[index] = (head[index] ?? 0) ^ 0xff
    return head
  }

  it('finds an AppImage that starts with the pinned runtime, but for its 16-byte digest', () => {
    expect(embedsRuntime(RUNTIME, RUNTIME)).toBe(true)
    expect(embedsRuntime(withDigest(40, 56), RUNTIME)).toBe(true)
    // A changed byte outside one 16-byte run, or another runtime, is not the pinned one.
    expect(embedsRuntime(withDigest(40, 57), RUNTIME)).toBe(false)
    const other = withDigest(0, 1)
    other.set(withDigest(40, 56).subarray(40, 56), 40)
    expect(embedsRuntime(other, RUNTIME)).toBe(false)
    expect(embedsRuntime(RUNTIME.subarray(0, 63), RUNTIME)).toBe(false)
  })

  it('passes a build that used the checked tools only, behind the pinned runtime', () => {
    placeBuild(withDigest(8, 24))
    expect(checkAfterBuild({ out: out(), tools, bundleDir: bundleDir() })).toEqual([
      'FXM_1.0.0_amd64.AppImage',
    ])
  })

  it('stops the job when the bundler fetched a tool itself', () => {
    placeBuild(RUNTIME)
    writeFileSync(join(out(), 'linuxdeploy-abcdef0-x86_64.AppImage'), '')
    expect(unexpectedTools(out(), tools)).toEqual(['linuxdeploy-abcdef0-x86_64.AppImage'])
    expect(() => checkAfterBuild({ out: out(), tools, bundleDir: bundleDir() })).toThrow(
      /fetched tools of its own, unchecked: linuxdeploy-abcdef0-x86_64\.AppImage/,
    )
  })

  it('stops the job when an AppImage starts with another runtime', () => {
    placeBuild(withDigest(0, 64))
    expect(() => checkAfterBuild({ out: out(), tools, bundleDir: bundleDir() })).toThrow(
      /FXM_1\.0\.0_amd64\.AppImage doesn't start with the pinned AppImage runtime/,
    )
  })

  it('stops the job when the runtime it compares with changed, or there is no AppImage', () => {
    placeBuild(RUNTIME)
    writeFileSync(join(out(), 'rt'), withDigest(0, 1))
    expect(() => checkAfterBuild({ out: out(), tools, bundleDir: bundleDir() })).toThrow(
      /rt in .* is no longer the pinned AppImage runtime/,
    )
    writeFileSync(join(out(), 'rt'), RUNTIME)
    rmSync(join(bundleDir(), 'appimage'), { recursive: true })
    expect(() => checkAfterBuild({ out: out(), tools, bundleDir: bundleDir() })).toThrow(
      /holds no AppImage to check/,
    )
  })

  it('runs as the workflow step, with the pinned tools and the build’s bundle folder', async () => {
    const { reporter } = recorder()
    mkdirSync(out())
    for (const name of [...appImageTools('aarch64').map((tool) => tool.name), ...BUNDLER_FILES]) {
      writeFileSync(join(out(), name), '')
    }
    const args = ['appimage-tools', '--triple', 'aarch64-unknown-linux-gnu', '--out', out()]
    await expect(main([...args, '--after-build'], {}, reporter)).rejects.toThrow(
      /--bundle-dir <value> is required/,
    )
    await expect(
      main([...args, '--after-build', '--bundle-dir', bundleDir()], {}, reporter),
    ).rejects.toThrow(/appimage-runtime-aarch64 in .* is no longer the pinned AppImage runtime/)
  })
})
