import { writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ffmpegCoreDevPlugin, ffmpegCoreMiddleware } from '../../../tools/ffmpeg-wasm/dev-server.ts'
import { removeTempDirs, tempDir } from './testing.ts'

afterEach(removeTempDirs)

/** Runs the middleware on `url`; resolves with what it answered, or 'next'. */
function request(middleware: ReturnType<typeof ffmpegCoreMiddleware>, url: string) {
  return new Promise<{ status: number; type: string | undefined; body: string } | 'next'>(
    (resolve) => {
      const chunks: Buffer[] = []
      const headers = new Map<string, string>()
      const response = Object.assign(
        new Writable({
          write(chunk, _encoding, done) {
            chunks.push(Buffer.from(chunk))
            done()
          },
        }),
        {
          statusCode: 0,
          setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
        },
      )
      const finish = () =>
        resolve({
          status: response.statusCode,
          type: headers.get('content-type'),
          body: Buffer.concat(chunks).toString(),
        })
      response.on('finish', finish)
      const end = response.end.bind(response)
      response.end = ((chunk?: unknown) => end(chunk as string)) as typeof response.end
      middleware({ url } as IncomingMessage, response as unknown as ServerResponse, () =>
        resolve('next'),
      )
    },
  )
}

describe('the ffmpeg core on the dev server', () => {
  it('serves the built core under the app’s base, with the right types', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'ffmpeg-core.json'), '{"schema":1}')
    writeFileSync(join(dir, 'ffmpeg-core.wasm'), 'wasm')
    const middleware = ffmpegCoreMiddleware('/app/', () => dir)
    expect(await request(middleware, '/app/ffmpeg/ffmpeg-core.json?v=1')).toEqual({
      status: 200,
      type: 'application/json; charset=utf-8',
      body: '{"schema":1}',
    })
    expect(await request(middleware, '/app/ffmpeg/ffmpeg-core.wasm')).toMatchObject({
      type: 'application/wasm',
    })
    // Not built: a 404 that says how to build it.
    expect(await request(middleware, '/app/ffmpeg/ffmpeg-core.js')).toMatchObject({
      status: 404,
      body: 'No ffmpeg core is built here: run make ffmpeg-wasm',
    })
    // Nothing else from that folder, and nothing outside it.
    expect(await request(middleware, '/app/ffmpeg/../../secret')).toMatchObject({ status: 404 })
    expect(await request(middleware, '/app/assets/index.js')).toBe('next')
  })

  it('follows the base the app is built for', () => {
    const plugin = ffmpegCoreDevPlugin()
    const used: unknown[] = []
    plugin.configResolved({ base: '/' })
    plugin.configureServer({ middlewares: { use: (middleware) => used.push(middleware) } })
    plugin.configurePreviewServer({ middlewares: { use: (middleware) => used.push(middleware) } })
    expect(used).toHaveLength(2)
  })
})
