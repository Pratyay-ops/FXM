/**
 * Test helpers for signed updates: a throwaway signing key, a fake static site that serves
 * update files, and a module importer for Node, which can't import `blob:` URLs. Exported by
 * `@fxm/platform/testing`, for the tests of this package and of the apps that wire the updater
 * (7.2, 6.2). Tests only: never import this from app code.
 *
 * @module
 */

import { utf8 } from './encoding.ts'
import { SIGNATURE_SUFFIX } from './format.ts'
import type { ModuleImporter } from './loader.ts'
import { generateSigningKey, importSigningKey, type SignedUpdate, signUpdate } from './sign.ts'
import type { UpdateFetch, UpdateRequestInit } from './updater.ts'
import type { TrustedKey } from './verify.ts'

/** A throwaway key pair that signs like the owner's. */
export interface TestSigner {
  /** The public key, as a build would trust it. */
  readonly trusted: TrustedKey
  /** Signs `bytes` as `file`, of `kind` and `version`. */
  sign(input: {
    kind: string
    version: number
    file: string
    bytes: Uint8Array
    api?: number
    source?: string
  }): Promise<SignedUpdate>
}

/** Creates a new {@link TestSigner} with a fresh Ed25519 key pair (WebCrypto). */
export async function createTestSigner(): Promise<TestSigner> {
  const generated = await generateSigningKey()
  const key = await importSigningKey(generated.pkcs8)
  return {
    trusted: { keyId: key.keyId, publicKey: key.publicKey },
    sign: (input) => signUpdate(key, input),
  }
}

/** How the fake site answers one URL. */
export type FakeRoute = (init: UpdateRequestInit) => Response | Promise<Response>

/** A fake static site, as an {@link UpdateFetch}. */
export interface FakeUpdateSite {
  /** The fetch to give the updater. */
  readonly fetch: UpdateFetch
  /** Every URL requested, in order. */
  readonly requests: string[]
  /** Serves `bytes` (or text) at `url` with 200. */
  serve(url: string, body: Uint8Array | string): void
  /** Serves a signed update: the artifact at `<base><file>` and its signature next to it. */
  publish(base: string, file: string, bytes: Uint8Array | string, signed: SignedUpdate): void
  /** Answers `url` with `route`. */
  route(url: string, route: FakeRoute): void
  /** Makes `url` fail like an unreachable host. */
  unreachable(url: string): void
  /** Makes `url` never answer until the request is cancelled. */
  hang(url: string): void
}

function bytesOf(body: Uint8Array | string): Uint8Array<ArrayBuffer> {
  return typeof body === 'string' ? utf8(body) : new Uint8Array(body)
}

/**
 * A fake static site. Unknown URLs get 404, as Cloudflare Pages answers before anything is
 * published. Like a real `fetch`, a request rejects once its signal aborts.
 */
export function fakeUpdateSite(): FakeUpdateSite {
  const routes = new Map<string, FakeRoute>()
  const requests: string[] = []
  const site: FakeUpdateSite = {
    requests,
    async fetch(url, init) {
      requests.push(url)
      init.signal.throwIfAborted()
      const route = routes.get(url)
      if (route === undefined) return new Response('Not found', { status: 404 })
      const answer = route(init)
      return await new Promise<Response>((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        Promise.resolve(answer).then(resolve, reject)
      })
    },
    serve(url, body) {
      const bytes = bytesOf(body)
      routes.set(url, () => new Response(new Uint8Array(bytes), { status: 200 }))
    },
    publish(base, file, bytes, signed) {
      site.serve(`${base}${file}`, bytes)
      site.serve(`${base}${file}${SIGNATURE_SUFFIX}`, signed.envelope)
    },
    route(url, route) {
      routes.set(url, route)
    },
    unreachable(url) {
      routes.set(url, () => Promise.reject(new TypeError('fetch failed')))
    },
    hang(url) {
      routes.set(url, () => new Promise<Response>(() => {}))
    },
  }
  return site
}

/**
 * Imports a `blob:` URL in Node, which can only import `data:` URLs: reads the blob back
 * through `fetch` (so the test sees exactly the bytes the loader put in it) and imports them as
 * a `data:` URL.
 */
export const nodeModuleImporter: ModuleImporter = async (url) => {
  const response = await fetch(url)
  const bytes = new Uint8Array(await response.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return import(/* @vite-ignore */ `data:text/javascript;base64,${btoa(binary)}`)
}
