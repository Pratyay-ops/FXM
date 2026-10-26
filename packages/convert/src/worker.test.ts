import { describe, expect, it, vi } from 'vitest'
import { type ConverterWorker, createConverter } from './client'
import type { FfmpegCore } from './core'
import type { ConverterReply, ConverterRequest, ExportJob } from './protocol'
import { FakeFfmpegCore, mp3File, oggOpusFile } from './testing'
import { ConvertError } from './types'
import { serveConversions, toConvertError } from './worker'

const JOB: ExportJob = {
  input: new Blob([oggOpusFile() as BlobPart]),
  source: { codec: 'opus', container: 'ogg', media: 'audio' },
  format: 'mp3',
  tags: { title: 'Song', artists: ['A'] },
}

/**
 * A worker and its scope joined in-process: what the page posts reaches serveConversions, and
 * what the worker posts reaches the page, a tick later each, as with real workers.
 */
function inProcessWorker(loadCore: (base: string) => Promise<FfmpegCore>) {
  const toPage: ((event: MessageEvent<ConverterReply>) => void)[] = []
  const toWorker: ((event: MessageEvent<ConverterRequest>) => void)[] = []
  const errors: ((event: Event) => void)[] = []
  let terminated = false
  serveConversions(
    {
      addEventListener: (_type, listener) => toWorker.push(listener),
      postMessage: (message) => {
        if (terminated) return
        queueMicrotask(() => {
          for (const listener of toPage) listener(new MessageEvent('message', { data: message }))
        })
      },
    },
    { loadCore },
  )
  const worker: ConverterWorker & { readonly terminated: boolean; fail(): void } = {
    postMessage: (message) => {
      queueMicrotask(() => {
        for (const listener of toWorker) listener(new MessageEvent('message', { data: message }))
      })
    },
    addEventListener: ((type: string, listener: (event: never) => void) => {
      if (type === 'message') toPage.push(listener as (event: MessageEvent<ConverterReply>) => void)
      else errors.push(listener as (event: Event) => void)
    }) as ConverterWorker['addEventListener'],
    terminate: () => {
      terminated = true
    },
    get terminated() {
      return terminated
    },
    fail: () => {
      for (const listener of errors) listener(new Event('error'))
    },
  }
  return worker
}

describe('the conversion worker and its client', () => {
  it('runs a job in the worker, reporting progress, and hands the file back', async () => {
    const core = new FakeFfmpegCore()
    const loadCore = vi.fn(async () => core)
    const converter = createConverter({
      createWorker: () => inProcessWorker(loadCore),
      coreBase: 'https://fxm.test/app/ffmpeg/',
    })
    const progress: number[] = []
    const outcome = await converter.exportAudio(JOB, { onProgress: (done) => progress.push(done) })
    expect(outcome.tagged).toBe(true)
    expect(outcome.blob.type).toBe('audio/mpeg')
    expect(progress.at(-1)).toBe(1)
    expect(loadCore).toHaveBeenCalledWith('https://fxm.test/app/ffmpeg/')
    // A second job reuses the loaded core.
    await converter.exportAudio(JOB)
    expect(loadCore).toHaveBeenCalledTimes(1)
    expect(core.calls).toHaveLength(2)
  })

  it('runs jobs one at a time, in order', async () => {
    const core = new FakeFfmpegCore()
    const converter = createConverter({
      createWorker: () => inProcessWorker(async () => core),
      coreBase: 'https://fxm.test/',
    })
    const order: string[] = []
    await Promise.all([
      converter.exportAudio({ ...JOB, format: 'flac' }).then(() => order.push('flac')),
      converter.exportAudio({ ...JOB, format: 'wav' }).then(() => order.push('wav')),
    ])
    expect(order).toEqual(['flac', 'wav'])
    expect(core.calls.map((call) => call.job.format)).toEqual(['flac', 'wav'])
  })

  it('passes errors on, and tries to load a core that failed to load again next time', async () => {
    const core = new FakeFfmpegCore()
    const loadCore = vi
      .fn<(base: string) => Promise<FfmpegCore>>()
      .mockRejectedValueOnce(new ConvertError('core-unavailable', 'HTTP 404'))
      .mockResolvedValue(core)
    const converter = createConverter({
      createWorker: () => inProcessWorker(loadCore),
      coreBase: 'https://fxm.test/',
    })
    await expect(converter.exportAudio(JOB)).rejects.toMatchObject({ code: 'core-unavailable' })
    await expect(converter.exportAudio(JOB)).resolves.toMatchObject({ tagged: true })
    expect(loadCore).toHaveBeenCalledTimes(2)
  })

  it('replaces a core that ran out of memory', async () => {
    const first = new FakeFfmpegCore()
    first.failNext = new ConvertError('out-of-memory', 'Aborted(OOM)')
    const second = new FakeFfmpegCore()
    const loadCore = vi
      .fn<(base: string) => Promise<FfmpegCore>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const converter = createConverter({
      createWorker: () => inProcessWorker(loadCore),
      coreBase: 'https://fxm.test/',
    })
    await expect(converter.exportAudio(JOB)).rejects.toMatchObject({ code: 'out-of-memory' })
    await converter.exportAudio(JOB)
    expect(second.calls).toHaveLength(1)
  })

  it('reports memory running out as such, never as a damaged file', async () => {
    const core = new FakeFfmpegCore()
    core.convert = async () => {
      throw new RangeError('Array buffer allocation failed')
    }
    const converter = createConverter({
      createWorker: () => inProcessWorker(async () => core),
      coreBase: 'https://fxm.test/',
    })
    await expect(converter.exportAudio(JOB)).rejects.toMatchObject({ code: 'out-of-memory' })
    expect(toConvertError(new RangeError('Invalid typed array length: -4')).code).toBe('failed')
    expect(toConvertError(new TypeError('x is not a function')).code).toBe('failed')
    expect(toConvertError(new ConvertError('corrupt-input', 'bad')).code).toBe('corrupt-input')
  })

  it('saves an original WebM untagged when the core never loads', async () => {
    const loadCore = vi.fn(async (): Promise<FfmpegCore> => {
      throw new ConvertError('core-unavailable', 'HTTP 404')
    })
    const converter = createConverter({
      createWorker: () => inProcessWorker(loadCore),
      coreBase: 'https://fxm.test/',
    })
    const webm = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])])
    const outcome = await converter.exportAudio({
      ...JOB,
      input: webm,
      source: { codec: 'opus', container: 'webm', media: 'audio' },
      format: 'original',
    })
    expect(outcome.tagged).toBe(false)
    expect(new Uint8Array(await outcome.blob.arrayBuffer())).toEqual(
      new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]),
    )
    await expect(converter.exportAudio(JOB)).rejects.toMatchObject({ code: 'core-unavailable' })
  })

  it('replaces a core that stopped mid-way, even when the original went on without it', async () => {
    const first = new FakeFfmpegCore()
    first.failNext = new ConvertError('failed', 'The ffmpeg core stopped: unreachable', {
      cause: new Error('RuntimeError: unreachable'),
    })
    const second = new FakeFfmpegCore()
    const loadCore = vi
      .fn<(base: string) => Promise<FfmpegCore>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const converter = createConverter({
      createWorker: () => inProcessWorker(loadCore),
      coreBase: 'https://fxm.test/',
    })
    const original = await converter.exportAudio({
      ...JOB,
      source: { codec: 'opus', container: 'webm', media: 'audio' },
      format: 'original',
    })
    expect(original.tagged).toBe(false)
    await converter.exportAudio(JOB)
    expect(loadCore).toHaveBeenCalledTimes(2)
    expect(second.calls).toHaveLength(1)
  })

  it('keeps a core whose conversion failed without stopping it', async () => {
    const core = new FakeFfmpegCore()
    core.failNext = new ConvertError('unsupported-input', 'Decoder not found')
    const loadCore = vi.fn(async () => core)
    const converter = createConverter({
      createWorker: () => inProcessWorker(loadCore),
      coreBase: 'https://fxm.test/',
    })
    await expect(converter.exportAudio(JOB)).rejects.toMatchObject({ code: 'unsupported-input' })
    await converter.exportAudio(JOB)
    expect(loadCore).toHaveBeenCalledTimes(1)
  })

  it('reports a file that isn’t what its format says as damaged', async () => {
    const converter = createConverter({
      createWorker: () => inProcessWorker(async () => new FakeFfmpegCore()),
      coreBase: 'https://fxm.test/',
    })
    await expect(
      converter.exportAudio({
        ...JOB,
        input: new Blob([mp3File() as BlobPart]),
        source: { codec: 'aac', container: 'mp4', media: 'muxed-video' },
        format: 'original',
      }),
    ).rejects.toMatchObject({ code: 'corrupt-input' })
  })

  it('cancels a running job by stopping its worker, and the next job gets a new one', async () => {
    let release: () => void = () => {}
    const slowCore = new FakeFfmpegCore()
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const workers: ReturnType<typeof inProcessWorker>[] = []
    const converter = createConverter({
      createWorker: () => {
        const worker = inProcessWorker(async () => {
          if (workers.length === 1) await blocked
          return slowCore
        })
        workers.push(worker)
        return worker
      },
      coreBase: 'https://fxm.test/',
    })
    const controller = new AbortController()
    const running = converter.exportAudio(JOB, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await expect(running).rejects.toMatchObject({ code: 'cancelled' })
    expect(workers[0]?.terminated).toBe(true)
    release()
    await expect(converter.exportAudio(JOB)).resolves.toMatchObject({ tagged: true })
    expect(workers).toHaveLength(2)
  })

  it('never starts a queued job that was cancelled', async () => {
    const core = new FakeFfmpegCore()
    const converter = createConverter({
      createWorker: () => inProcessWorker(async () => core),
      coreBase: 'https://fxm.test/',
    })
    const controller = new AbortController()
    const first = converter.exportAudio(JOB)
    const second = converter.exportAudio(JOB, { signal: controller.signal })
    controller.abort()
    await first
    await expect(second).rejects.toMatchObject({ code: 'cancelled' })
    expect(core.calls).toHaveLength(1)
    await expect(converter.exportAudio(JOB, { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    })
  })

  it('fails only the running job when the worker crashes', async () => {
    const workers: ReturnType<typeof inProcessWorker>[] = []
    const never = new Promise<FfmpegCore>(() => {})
    const converter = createConverter({
      createWorker: () => {
        const worker = inProcessWorker(
          workers.length === 0 ? () => never : async () => new FakeFfmpegCore(),
        )
        workers.push(worker)
        return worker
      },
      coreBase: 'https://fxm.test/',
    })
    const crashing = converter.exportAudio(JOB)
    const next = converter.exportAudio(JOB)
    await new Promise((resolve) => setTimeout(resolve, 0))
    workers[0]?.fail()
    await expect(crashing).rejects.toMatchObject({ code: 'failed' })
    await expect(next).resolves.toMatchObject({ tagged: true })
  })

  it('fails everything left when disposed', async () => {
    const converter = createConverter({
      createWorker: () => inProcessWorker(() => new Promise(() => {})),
      coreBase: 'https://fxm.test/',
    })
    const first = converter.exportAudio(JOB)
    const second = converter.exportAudio(JOB)
    converter.dispose()
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    await expect(second).rejects.toMatchObject({ code: 'cancelled' })
  })
})
