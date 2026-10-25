/**
 * Loading verified code: the bytes of a signed module, already checked against their
 * signature, become an ES module through a `blob:` URL made from exactly those bytes. Nothing is
 * fetched again between the check and the import.
 *
 * The page's Content Security Policy must allow it: `script-src` needs `blob:`. Only the
 * desktop and Android builds have that; the web app's policy doesn't, and it never loads
 * downloaded code (it gets new code by redeploy). {@link canImportModules} finds out, without a
 * request, before anything is downloaded.
 *
 * @module
 */

import { FxmError } from '@fxm/core'

/** Imports the ES module at a URL, e.g. `(url) => import(url)`. */
export type ModuleImporter = (url: string) => Promise<unknown>

/** Options for {@link importModuleFromBytes}. */
export interface ModuleImportOptions {
  /**
   * How to import the `blob:` URL. Default: the platform's dynamic `import()`. Tests in Node,
   * which can't import `blob:` URLs, pass one that imports the bytes another way.
   */
  readonly importer?: ModuleImporter
}

/** The platform's own dynamic `import()`, which bundlers must leave alone. */
const nativeImport: ModuleImporter = (url) => import(/* @vite-ignore */ url)

/** A module that only exports `ok`, for {@link canImportModules}. */
const PROBE_MODULE = new TextEncoder().encode('export const ok = 1')

/**
 * Evaluates `bytes` as an ES module and returns its namespace (its exports). The `blob:` URL is
 * revoked once the import settles. Only pass bytes that passed signature verification.
 *
 * @throws FxmError `Unsupported` when the platform can't make or import `blob:` URLs (or its
 * Content Security Policy forbids them), `Parse` when the code fails to evaluate.
 */
export async function importModuleFromBytes(
  bytes: Uint8Array,
  options: ModuleImportOptions = {},
): Promise<Readonly<Record<string, unknown>>> {
  if (typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new FxmError('Unsupported', 'This platform cannot load code from blob: URLs')
  }
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'text/javascript' }))
  let namespace: unknown
  try {
    namespace = await (options.importer ?? nativeImport)(url)
  } catch (cause) {
    throw new FxmError('Parse', 'The downloaded module did not load', { cause })
  } finally {
    URL.revokeObjectURL(url)
  }
  if (typeof namespace !== 'object' || namespace === null) {
    throw new FxmError('Parse', 'The downloaded module has no exports')
  }
  return namespace as Readonly<Record<string, unknown>>
}

/**
 * Whether this platform can load code from `blob:` URLs at all: it has `Blob` and
 * `URL.createObjectURL`, and its Content Security Policy lets `import()` run one. Imports a
 * one-line module, with no request. When it can't, a module that fails to load says nothing
 * about the module, so the updater neither downloads code nor remembers a version as bad.
 */
export async function canImportModules(options: ModuleImportOptions = {}): Promise<boolean> {
  try {
    return (await importModuleFromBytes(PROBE_MODULE, options)).ok === 1
  } catch {
    return false
  }
}
