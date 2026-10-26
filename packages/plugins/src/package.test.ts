import { describe, expect, it } from 'vitest'
import { sha256Hex, utf8 } from './checksum'
import { isPluginError, type PluginErrorCode } from './errors'
import {
  checkPackage,
  createPluginFile,
  type DownloadFetch,
  downloadHosts,
  downloadPlugin,
  PACKAGE_LIMITS,
  pluginAddress,
  readPluginFile,
} from './package'
import { TEST_PLUGIN_CODE, testPluginFile, testPluginManifest } from './testing'

const MANIFEST_URL = 'https://plugins.example.org/test/fxm-plugin.json'

/** A site that serves `files` by URL and records what it was asked for. */
function site(files: Record<string, string | Uint8Array | Response>) {
  const asked: string[] = []
  const fetch: DownloadFetch = async (url, init) => {
    asked.push(url)
    expect(init.method).toBe('GET')
    const file = files[url]
    if (file === undefined) return new Response('not found', { status: 404 })
    if (file instanceof Response) return file
    return new Response(file as BodyInit)
  }
  return { fetch, asked }
}

async function failure(work: () => unknown): Promise<unknown> {
  try {
    await work()
  } catch (error) {
    return error
  }
  return undefined
}

async function expectFailure(work: () => unknown, code: PluginErrorCode, message?: RegExp) {
  const error = await failure(work)
  expect(isPluginError(error, code), String(error)).toBe(true)
  if (message !== undefined) expect((error as Error).message).toMatch(message)
}

describe('plugin files', () => {
  it('reads a plugin file and checks its code against the manifest', () => {
    const pkg = readPluginFile(testPluginFile(), 'test-catalog.fxmplugin.json')
    expect(pkg.manifest.id).toBe('test-catalog')
    expect(pkg.code).toBe(TEST_PLUGIN_CODE)
    expect(pkg.origin).toEqual({ kind: 'file', name: 'test-catalog.fxmplugin.json' })
  })

  it('refuses code that is not what the manifest declares', async () => {
    const text = createPluginFile(testPluginManifest(), `${TEST_PLUGIN_CODE}\n// changed`)
    await expectFailure(() => readPluginFile(text, 'x.json'), 'checksum-mismatch')
  })

  it('refuses files that are no plugin files, or too large', async () => {
    await expectFailure(() => readPluginFile('not json', 'x.json'), 'invalid-file', /not JSON/u)
    await expectFailure(
      () => readPluginFile(JSON.stringify(testPluginManifest()), 'x.json'),
      'invalid-file',
      /add the plugin from its address/u,
    )
    await expectFailure(
      () => readPluginFile(JSON.stringify({ fxmPluginFile: 1, manifest: {} }), 'x.json'),
      'invalid-file',
      /no code/u,
    )
    await expectFailure(
      () => readPluginFile(JSON.stringify({ fxmPluginFile: 2, manifest: {}, code: '' }), 'x.json'),
      'unsupported-api',
    )
    await expectFailure(
      () => readPluginFile(' '.repeat(PACKAGE_LIMITS.file + 1), 'x.json'),
      'too-large',
    )
    const big = 'x'.repeat(PACKAGE_LIMITS.code + 1)
    await expectFailure(
      () => readPluginFile(createPluginFile(testPluginManifest({}, big), big), 'x.json'),
      'too-large',
    )
  })

  it('refuses plugins that need a newer FXM, whatever else a newer FXM would read in them', async () => {
    for (const future of [{}, { provides: ['search', 'home'] }, { hosts: ['*.example.org'] }]) {
      await expectFailure(
        () =>
          readPluginFile(testPluginFile({ minFxmVersion: '9.0.0', ...future }), 'x.json', {
            appVersion: '1.0.0',
          }),
        'needs-newer-fxm',
      )
    }
  })
})

describe('checking a package again', () => {
  const pkg = () => readPluginFile(testPluginFile(), 'test.json')

  it('returns a package that passes every check, as read', () => {
    expect(checkPackage(pkg(), '1.0.0')).toEqual(pkg())
  })

  it('refuses a package built by hand that skips the checks', async () => {
    const good = pkg()
    await expectFailure(
      () => checkPackage({ ...good, code: `${good.code}\n// changed` }, '1.0.0'),
      'checksum-mismatch',
    )
    await expectFailure(
      () =>
        checkPackage(
          { ...good, manifest: { ...good.manifest, hosts: ['music.youtube.com'] } },
          '1.0.0',
        ),
      'invalid-manifest',
    )
    await expectFailure(
      () =>
        checkPackage(
          { ...good, origin: { kind: 'url', url: 'http://plain.example.org/' } },
          '1.0.0',
        ),
      'invalid-file',
    )
    await expectFailure(() => checkPackage(undefined, '1.0.0'), 'invalid-file')
    await expectFailure(
      () =>
        checkPackage({ ...good, manifest: { ...good.manifest, minFxmVersion: '2.0.0' } }, '1.0.0'),
      'needs-newer-fxm',
    )
  })
})

describe('downloads', () => {
  it('downloads a manifest, then its code from the same origin', async () => {
    const { fetch, asked } = site({
      [MANIFEST_URL]: JSON.stringify(testPluginManifest({ entry: 'code/plugin.js' })),
      'https://plugins.example.org/test/code/plugin.js': TEST_PLUGIN_CODE,
    })
    const pkg = await downloadPlugin(MANIFEST_URL, fetch)
    expect(pkg.manifest.entry).toBe('code/plugin.js')
    expect(pkg.code).toBe(TEST_PLUGIN_CODE)
    expect(pkg.origin).toEqual({ kind: 'url', url: MANIFEST_URL })
    expect(asked).toEqual([MANIFEST_URL, 'https://plugins.example.org/test/code/plugin.js'])
  })

  it('fetches no code for a manifest that needs a newer FXM', async () => {
    const { fetch, asked } = site({
      [MANIFEST_URL]: JSON.stringify(
        testPluginManifest({ minFxmVersion: '9.0.0', provides: ['search', 'home'] }),
      ),
    })
    await expectFailure(
      () => downloadPlugin(MANIFEST_URL, fetch, { appVersion: '1.0.0' }),
      'needs-newer-fxm',
    )
    expect(asked).toEqual([MANIFEST_URL])
  })

  it('downloads a plugin file in one request', async () => {
    const url = 'https://plugins.example.org/test-catalog.fxmplugin.json'
    const { fetch, asked } = site({ [url]: testPluginFile() })
    const pkg = await downloadPlugin(url, fetch)
    expect(pkg.manifest.id).toBe('test-catalog')
    expect(asked).toEqual([url])
  })

  it('checks the code as bytes, keeping a byte order mark', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(TEST_PLUGIN_CODE)])
    const { fetch } = site({
      [MANIFEST_URL]: JSON.stringify(testPluginManifest({ sha256: sha256Hex(bytes) })),
      'https://plugins.example.org/test/plugin.js': bytes,
    })
    const pkg = await downloadPlugin(MANIFEST_URL, fetch)
    expect(pkg.code.charCodeAt(0)).toBe(0xfeff)
    expect(sha256Hex(utf8(pkg.code))).toBe(pkg.manifest.sha256)
  })

  it('fetches the code only from the manifest’s origin, which a relative entry cannot leave', async () => {
    const { fetch, asked } = site({
      [MANIFEST_URL]: JSON.stringify(testPluginManifest({ entry: '../../../evil/plugin.js' })),
    })
    await expectFailure(() => downloadPlugin(MANIFEST_URL, fetch), 'download-failed', /404/u)
    expect(asked).toHaveLength(2)
    expect(new URL(asked[1] ?? '').host).toBe('plugins.example.org')
  })

  it.each([
    ['plain HTTP', 'http://plugins.example.org/fxm-plugin.json'],
    ['a local host', 'https://plugins.local/fxm-plugin.json'],
    ['an IP address', 'https://10.0.0.2/fxm-plugin.json'],
    ['credentials', 'https://user:pw@plugins.example.org/fxm-plugin.json'],
    ['not a URL', 'plugins.example.org/fxm-plugin.json'],
  ])('downloads nothing from %s', async (_, address) => {
    const { fetch, asked } = site({})
    await expectFailure(() => downloadPlugin(address, fetch), 'invalid-file')
    expect(asked).toEqual([])
    expect(pluginAddress(address)).toBeUndefined()
  })

  it('fails on error statuses, unreachable hosts, wrong checksums and oversized files', async () => {
    await expectFailure(
      () => downloadPlugin(MANIFEST_URL, site({}).fetch),
      'download-failed',
      /404/u,
    )
    const unreachable: DownloadFetch = async () => {
      throw new TypeError('Failed to fetch')
    }
    await expectFailure(
      () => downloadPlugin(MANIFEST_URL, unreachable),
      'download-failed',
      /couldn't download the plugin from plugins\.example\.org/u,
    )
    const wrong = site({
      [MANIFEST_URL]: JSON.stringify(testPluginManifest()),
      'https://plugins.example.org/test/plugin.js': `${TEST_PLUGIN_CODE} `,
    })
    await expectFailure(() => downloadPlugin(MANIFEST_URL, wrong.fetch), 'checksum-mismatch')
    const huge = site({
      [MANIFEST_URL]: new Response('x', {
        headers: { 'content-length': String(PACKAGE_LIMITS.file + 1) },
      }),
    })
    await expectFailure(() => downloadPlugin(MANIFEST_URL, huge.fetch), 'too-large')
    const streamed = site({
      [MANIFEST_URL]: JSON.stringify(testPluginManifest()),
      'https://plugins.example.org/test/plugin.js': new Uint8Array(PACKAGE_LIMITS.code + 1),
    })
    await expectFailure(() => downloadPlugin(MANIFEST_URL, streamed.fetch), 'too-large')
    const notJson = site({ [MANIFEST_URL]: '<html>' })
    await expectFailure(() => downloadPlugin(MANIFEST_URL, notJson.fetch), 'invalid-file')
  })

  it('stops when the caller cancels', async () => {
    const controller = new AbortController()
    const reason = new Error('closed the dialog')
    const slow: DownloadFetch = (_, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted')))
      })
    const pending = downloadPlugin(MANIFEST_URL, slow, { signal: controller.signal })
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it('names the one host a download contacts', () => {
    expect(downloadHosts(new URL(MANIFEST_URL))).toEqual(['plugins.example.org'])
    expect(downloadHosts(new URL('https://plugins.example.org:8443/x'))).toEqual([
      'plugins.example.org:8443',
    ])
    expect(downloadHosts(new URL('http://plugins.example.org/x'))).toEqual([])
  })
})
