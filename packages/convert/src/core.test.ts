import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  CORE_FILES,
  type CoreModule,
  type CoreModuleFactory,
  coreOptions,
  createCore,
  errorCodeOf,
  loadFfmpegCore,
} from './core'

/** The smallest WebAssembly module there is: the magic number and version 1, nothing else. */
const WASM = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const LGPL = 'LGPL version 2.1 or later'

interface FakeFile {
  data: Uint8Array
}

/** A fake Emscripten module: an in-memory file system and a scripted fxm_convert. */
function fakeModule(options: { license?: string; convert?: (args: unknown[]) => number } = {}) {
  const files = new Map<string, FakeFile>()
  const dirs = new Set<string>(['/'])
  const mounts: string[] = []
  const calls: { name: string; args: unknown[] }[] = []
  const module: CoreModule & {
    onConvertProgress?: ((done: number, total: number) => void) | undefined
  } = {
    onConvertProgress: undefined,
    FS: {
      filesystems: { MEMFS: {}, WORKERFS: { worker: true } },
      mkdir: (path: string) => dirs.add(path),
      mount: (_type: unknown, mountOptions: { blobs: { name: string }[] }, at: string) => {
        mounts.push(`${at}/${mountOptions.blobs[0]?.name}`)
      },
      unmount: (at: string) => mounts.push(`unmount ${at}`),
      writeFile: (path: string, data: Uint8Array) => files.set(path, { data }),
      readFile: (path: string) => {
        const file = files.get(path)
        if (!file) throw new Error(`ENOENT ${path}`)
        return file.data
      },
      unlink: (path: string) => files.delete(path),
      analyzePath: (path: string) => ({ exists: files.has(path) || dirs.has(path) }),
    },
    ccall: (name: string, _returns: string, _types: string[], args: unknown[]) => {
      calls.push({ name, args })
      if (name === 'fxm_version') {
        return JSON.stringify({
          ffmpeg: '9.0.2',
          license: options.license ?? LGPL,
          configuration: '',
        })
      }
      if (name === 'fxm_convert') {
        const code = options.convert?.(args) ?? 0
        if (code === 0) {
          module.onConvertProgress?.(5, 10)
          files.set(String(args[1]), { data: new Uint8Array([9, 9, 9]) })
        }
        return code
      }
      if (name === 'fxm_last_error') return "can't read the input: Invalid data found"
      if (name === 'fxm_log') return '[mp3 @ 0x1] Header missing\n'
      if (name === 'fxm_probe') return JSON.stringify({ format: 'wav', codec: 'pcm_s16le' })
      return ''
    },
  }
  return { module, files, dirs, mounts, calls }
}

function loaderFor(files: Record<string, Uint8Array | object | number>, module: CoreModule) {
  const fetched: { url: string; cache?: string }[] = []
  const fetchFile = async (url: string, init?: RequestInit) => {
    fetched.push({ url, ...(init?.cache === undefined ? {} : { cache: init.cache }) })
    const name = new URL(url).pathname.split('/').pop() ?? ''
    const body = files[name]
    if (body === undefined || typeof body === 'number') {
      return new Response('missing', { status: typeof body === 'number' ? body : 404 })
    }
    return body instanceof Uint8Array
      ? new Response(body as BodyInit)
      : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }
  const imported: string[] = []
  const factoryOptions: Parameters<CoreModuleFactory>[0][] = []
  const instances: WebAssembly.Instance[] = []
  // Like Emscripten's glue: it hands instantiateWasm the imports and waits for the instance.
  const factory: CoreModuleFactory = async (options) => {
    factoryOptions.push(options)
    await new Promise<void>((resolve) => {
      options.instantiateWasm({ env: {} }, (instance) => {
        instances.push(instance)
        resolve()
      })
    })
    return module
  }
  const importScript = async (url: string) => {
    imported.push(url)
    return { default: factory }
  }
  return {
    fetched,
    imported,
    factoryOptions,
    instances,
    options: { fetch: fetchFile, importScript },
  }
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    ffmpegLicense: LGPL,
    files: {
      [CORE_FILES.script]: { bytes: 10, sha256: 'a'.repeat(64) },
      [CORE_FILES.wasm]: { bytes: WASM.length, sha256: sha(WASM) },
    },
    ...overrides,
  }
}

describe('loadFfmpegCore', () => {
  it('checks the manifest and the WebAssembly’s hash, then starts the core', async () => {
    const { module } = fakeModule()
    const loader = loaderFor({ 'ffmpeg-core.json': manifest(), 'ffmpeg-core.wasm': WASM }, module)
    const core = await loadFfmpegCore('https://fxm.test/app/ffmpeg/', loader.options)
    expect(core.version.license).toBe(LGPL)
    expect(loader.fetched[0]).toEqual({
      url: 'https://fxm.test/app/ffmpeg/ffmpeg-core.json',
      cache: 'no-cache',
    })
    // Versioned URLs, so a cached old file never pairs with a new one.
    expect(loader.fetched[1]?.url).toBe(
      `https://fxm.test/app/ffmpeg/ffmpeg-core.wasm?v=${sha(WASM).slice(0, 16)}`,
    )
    expect(loader.imported).toEqual([
      `https://fxm.test/app/ffmpeg/ffmpeg-core.js?v=${'a'.repeat(16)}`,
    ])
  })

  it('runs the bytes it checked: the glue never fetches the WebAssembly itself', async () => {
    const { module } = fakeModule()
    const loader = loaderFor({ 'ffmpeg-core.json': manifest(), 'ffmpeg-core.wasm': WASM }, module)
    await loadFfmpegCore('https://fxm.test/app/ffmpeg/', loader.options)
    expect(loader.instances).toHaveLength(1)
    expect(loader.instances[0]).toBeInstanceOf(WebAssembly.Instance)
    // Only the options the build reads (INCOMING_MODULE_JS_API in recipe/build.sh).
    expect(Object.keys(loader.factoryOptions[0] ?? {}).sort()).toEqual([
      'instantiateWasm',
      'print',
      'printErr',
    ])
    expect(loader.fetched.filter((item) => item.url.includes('.wasm'))).toHaveLength(1)
  })

  it('says the core can’t start when its WebAssembly doesn’t instantiate, without hanging', async () => {
    // Bytes that match the manifest but aren't WebAssembly.
    const broken = new Uint8Array([1, 2, 3, 4])
    const loader = loaderFor(
      {
        'ffmpeg-core.json': manifest({
          files: {
            [CORE_FILES.script]: { bytes: 10, sha256: 'a'.repeat(64) },
            [CORE_FILES.wasm]: { bytes: broken.length, sha256: sha(broken) },
          },
        }),
        'ffmpeg-core.wasm': broken,
      },
      fakeModule().module,
    )
    await expect(loadFfmpegCore('https://fxm.test/', loader.options)).rejects.toMatchObject({
      code: 'core-unavailable',
      message: expect.stringMatching(/^The ffmpeg core can't start: /),
    })
  })

  it('fetches the WebAssembly again, past the cache, when it doesn’t match, then gives up', async () => {
    const { module } = fakeModule()
    const loader = loaderFor(
      { 'ffmpeg-core.json': manifest(), 'ffmpeg-core.wasm': new Uint8Array([1, 2, 3]) },
      module,
    )
    await expect(loadFfmpegCore('https://fxm.test/', loader.options)).rejects.toMatchObject({
      code: 'core-unavailable',
      message: "The ffmpeg core doesn't match its manifest",
    })
    expect(loader.fetched.map((item) => item.cache)).toEqual(['no-cache', 'default', 'reload'])
  })

  it('says the core is unavailable when it isn’t deployed', async () => {
    const loader = loaderFor({ 'ffmpeg-core.json': 404 }, fakeModule().module)
    await expect(loadFfmpegCore('https://fxm.test/', loader.options)).rejects.toMatchObject({
      code: 'core-unavailable',
    })
  })

  it('refuses a core that isn’t LGPL, by its manifest or by its libraries', async () => {
    const gpl = loaderFor(
      {
        'ffmpeg-core.json': manifest({ ffmpegLicense: 'GPL version 2 or later' }),
        'ffmpeg-core.wasm': WASM,
      },
      fakeModule().module,
    )
    await expect(loadFfmpegCore('https://fxm.test/', gpl.options)).rejects.toThrow(/GPL version 2/)
    const lying = loaderFor(
      { 'ffmpeg-core.json': manifest(), 'ffmpeg-core.wasm': WASM },
      fakeModule({ license: 'GPL version 3 or later' }).module,
    )
    await expect(loadFfmpegCore('https://fxm.test/', lying.options)).rejects.toThrow(
      /libraries report the licence "GPL version 3 or later"/,
    )
  })
})

describe('createCore', () => {
  const version = { ffmpeg: '9.0.2', license: LGPL, configuration: '' }

  it('writes the input to memory outside a worker, runs fxm_convert and reads the output', async () => {
    const fake = fakeModule()
    const core = createCore(fake.module, version)
    const progress: number[] = []
    const out = await core.convert(
      new Blob([new Uint8Array([1, 2])]),
      { format: 'flac', codec: 'flac' },
      {
        inputExtension: 'webm',
        outputExtension: 'flac',
        onProgress: (done) => progress.push(done),
      },
    )
    expect(out).toEqual(new Uint8Array([9, 9, 9]))
    expect(progress).toEqual([0.5])
    const call = fake.calls.find((item) => item.name === 'fxm_convert')
    expect(call?.args).toEqual([
      '/fxm-input/input.webm',
      '/fxm-output/output.flac',
      'format=flac\ncodec=flac',
    ])
    // Nothing left behind for the next job.
    expect([...fake.files.keys()]).toEqual([])
  })

  it('mounts the Blob with WORKERFS inside a worker, and unmounts it', async () => {
    vi.stubGlobal('FileReaderSync', class {})
    try {
      const fake = fakeModule()
      const core = createCore(fake.module, version)
      await core.convert(
        new Blob([new Uint8Array([1])]),
        { format: 'mp3', codec: 'libmp3lame' },
        {
          inputExtension: 'm4a',
          outputExtension: 'mp3',
        },
      )
      expect(fake.mounts).toEqual(['/fxm-input/input.m4a', 'unmount /fxm-input'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('turns a failed conversion into a ConvertError with FFmpeg’s message and log', async () => {
    const fake = fakeModule({ convert: () => -1094995529 })
    const core = createCore(fake.module, version)
    await expect(
      core.convert(
        new Uint8Array([1]),
        { format: 'flac', codec: 'flac' },
        {
          inputExtension: 'mp3',
          outputExtension: 'flac',
        },
      ),
    ).rejects.toMatchObject({
      code: 'corrupt-input',
      message: "can't read the input: Invalid data found\n[mp3 @ 0x1] Header missing",
    })
  })

  it('reports a trap as the core stopping, out of memory when it says so', async () => {
    const fake = fakeModule({
      convert: () => {
        throw new Error('Aborted(OOM)')
      },
    })
    const core = createCore(fake.module, version)
    await expect(
      core.convert(
        new Uint8Array([1]),
        { format: 'wav', codec: 'pcm' },
        {
          inputExtension: 'flac',
          outputExtension: 'wav',
        },
      ),
    ).rejects.toMatchObject({ code: 'out-of-memory' })
  })

  it('probes an input', async () => {
    const core = createCore(fakeModule().module, version)
    expect(await core.probe(new Uint8Array([1]), 'wav')).toEqual({
      format: 'wav',
      codec: 'pcm_s16le',
    })
  })
})

describe('coreOptions', () => {
  it('writes key=value lines, percent-encoding values with line breaks', () => {
    expect(
      coreOptions({
        format: 'webm',
        codec: 'copy',
        bitRate: 160_000.4,
        compressionLevel: 5,
        metadata: { title: '100% Hits', lyrics: 'One\nTwo\r\n', 'bad key': 'x', empty: '' },
      }),
    ).toBe(
      'format=webm\ncodec=copy\nbitrate=160000\ncompression_level=5\nmetadata.title=100%25 Hits\nmetadata.lyrics=One%0ATwo%0D%0A',
    )
  })
})

describe('errorCodeOf', () => {
  it('maps FFmpeg’s codes to what the UI says', () => {
    expect(errorCodeOf(-1094995529)).toBe('corrupt-input')
    expect(errorCodeOf(-(0xf8 | (0x44 << 8) | (0x45 << 16) | (0x43 << 24)))).toBe(
      'unsupported-input',
    )
    expect(errorCodeOf(-48)).toBe('out-of-memory')
    expect(errorCodeOf(-5)).toBe('failed')
  })
})
