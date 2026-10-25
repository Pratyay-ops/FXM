/**
 * What the updater updates: an {@link UpdateArtifact} says where an artifact lives, how large it
 * may be, which version the app ships with, and how to load and switch to a verified one. The
 * updater is generic; the YouTube config and resolver module are two such artifacts
 * (`@fxm/sources/youtube/module`).
 *
 * {@link jsonArtifact} and {@link codeArtifact} build artifacts for JSON data and ES modules.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import { fromUtf8 } from './encoding.ts'
import { DEFAULT_CODE_MAX_BYTES, DEFAULT_JSON_MAX_BYTES, type UpdateStatement } from './format.ts'
import { canImportModules, importModuleFromBytes, type ModuleImportOptions } from './loader.ts'

/** Where the version in use came from. */
export type UpdateOrigin = 'bundled' | 'stored' | 'fetched'

/** What the updater tells an artifact when it switches to a verified version. */
export interface ActivationInfo {
  /** `stored`: kept from an earlier run; `fetched`: just downloaded. */
  readonly origin: Exclude<UpdateOrigin, 'bundled'>
  /** The version. */
  readonly version: number
}

/** The version of an artifact in use, and where it came from. */
export interface VersionInUse {
  /** The version. */
  readonly version: number
  /** Where it came from. */
  readonly origin: UpdateOrigin
}

/** Called by an artifact when a version it switched to fails at first use (see `watch`). */
export type FailureListener = (version: number, reason: string) => void

/**
 * One kind of artifact the updater keeps current. The value type `T` is what `load` makes of
 * the bytes, e.g. a parsed config or a module's exports.
 */
export interface UpdateArtifact<T = unknown> {
  /** Its kind, as signed statements name it, e.g. `youtube-config`. */
  readonly kind: string
  /** Its file name under each update URL, e.g. `youtube-config-1.json`. */
  readonly file: string
  /**
   * The contract version that statements must carry, which is also in the file name: for code,
   * the contract between the app and the module; for data, its schema.
   */
  readonly api?: number
  /** The largest artifact accepted, in bytes. */
  readonly maxBytes: number
  /**
   * Whether it is code. F-Droid builds load code only after the user's opt-in, and never load a
   * stored module while the opt-in is off.
   */
  readonly executable: boolean
  /** The version the app ships with. Only higher versions replace it. */
  readonly bundledVersion: number
  /**
   * Turns verified bytes into the value to use, and checks it. Throws when the artifact can't be
   * used: the updater keeps what it has and remembers that version as bad, never to try it again.
   * Throw an `Unsupported` `FxmError` instead when it isn't the artifact's fault, such as a
   * config that the module in use can't read: the updater keeps what it has without remembering
   * the version, and tries again on a later check.
   */
  load(bytes: Uint8Array<ArrayBuffer>, statement: UpdateStatement): T | Promise<T>
  /**
   * Switches to a loaded, verified version. It switches completely or, by throwing, not at all;
   * a throw counts as a failed load.
   */
  activate(value: T, info: ActivationInfo): void
  /** Switches back to the version the app ships with. */
  useBundled(): void
  /**
   * The version really in use, when it can differ from the last one the updater switched to:
   * e.g. a config whose module brings a newer copy of its own, or a module that went back to the
   * bundled one because a downloaded one didn't start. The updater compares offers with it and
   * reports it. Without it, the updater assumes the version it last switched to.
   */
  inUse?(): VersionInUse
  /**
   * For an artifact whose version can fail after `activate`, at first use: the updater calls it
   * once, when it is created, with a listener. Call it with the version that failed, once the
   * artifact has gone back to another one: the updater remembers that version as bad, drops its
   * stored copy and never tries it again.
   */
  watch?(failed: FailureListener): void
  /**
   * For code: whether this platform can load it at all. The updater asks before it restores or
   * downloads code; when the answer is no, it does neither, and remembers nothing as bad.
   */
  canLoad?(): Promise<boolean>
}

/** What {@link jsonArtifact} needs to know about a JSON artifact. */
export interface JsonArtifactSpec<T> {
  /** The kind. */
  readonly kind: string
  /** The file name. */
  readonly file: string
  /** The schema that statements must carry, if they carry one (see {@link UpdateArtifact.api}). */
  readonly api?: number
  /** The version the app ships with. */
  readonly bundledVersion: number
  /** The largest file accepted; {@link DEFAULT_JSON_MAX_BYTES} by default. */
  readonly maxBytes?: number
  /**
   * Checks the parsed JSON (and that its own version is the signed one), and returns the value.
   * See {@link UpdateArtifact.load} for what a throw means.
   */
  accept(json: unknown, statement: UpdateStatement): T
  /** See {@link UpdateArtifact.activate}. */
  activate(value: T, info: ActivationInfo): void
  /** See {@link UpdateArtifact.useBundled}. */
  useBundled(): void
  /** See {@link UpdateArtifact.inUse}. */
  inUse?(): VersionInUse
  /** See {@link UpdateArtifact.watch}. */
  watch?(failed: FailureListener): void
}

/** The optional hooks of a spec, copied onto the artifact only when the spec has them. */
function hooks(
  spec: Pick<UpdateArtifact, 'inUse' | 'watch'>,
): Pick<UpdateArtifact, 'inUse' | 'watch'> {
  const { inUse, watch } = spec
  return {
    ...(inUse === undefined ? {} : { inUse: () => inUse.call(spec) }),
    ...(watch === undefined
      ? {}
      : { watch: (failed: FailureListener) => watch.call(spec, failed) }),
  }
}

/** An artifact whose bytes are a UTF-8 JSON document, such as a config. */
export function jsonArtifact<T>(spec: JsonArtifactSpec<T>): UpdateArtifact<T> {
  return {
    kind: spec.kind,
    file: spec.file,
    ...(spec.api === undefined ? {} : { api: spec.api }),
    maxBytes: spec.maxBytes ?? DEFAULT_JSON_MAX_BYTES,
    executable: false,
    bundledVersion: spec.bundledVersion,
    load(bytes, statement) {
      let json: unknown
      try {
        json = JSON.parse(fromUtf8(bytes))
      } catch (cause) {
        throw new FxmError('Parse', `${spec.file} is not UTF-8 JSON`, { cause })
      }
      return spec.accept(json, statement)
    },
    activate: (value, info) => spec.activate(value, info),
    useBundled: () => spec.useBundled(),
    ...hooks(spec),
  }
}

/** What {@link codeArtifact} needs to know about a module. */
export interface CodeArtifactSpec<T> {
  /** The kind. */
  readonly kind: string
  /** The file name. */
  readonly file: string
  /** The app-module contract version this build speaks. */
  readonly api: number
  /** The version the app ships with. */
  readonly bundledVersion: number
  /** The largest file accepted; {@link DEFAULT_CODE_MAX_BYTES} by default. */
  readonly maxBytes?: number
  /**
   * Checks the module's exports (its contract version, that its own version is the signed one)
   * and returns the value to use. Throw to refuse it.
   */
  accept(exports: Readonly<Record<string, unknown>>, statement: UpdateStatement): T | Promise<T>
  /** See {@link UpdateArtifact.activate}. */
  activate(value: T, info: ActivationInfo): void
  /** See {@link UpdateArtifact.useBundled}. */
  useBundled(): void
  /** See {@link UpdateArtifact.inUse}. */
  inUse?(): VersionInUse
  /** See {@link UpdateArtifact.watch}. */
  watch?(failed: FailureListener): void
}

/**
 * An artifact whose bytes are an ES module, loaded from a `blob:` URL made from the verified
 * bytes (`importModuleFromBytes`). Desktop and Android only: their `script-src` allows `blob:`.
 * Whether the platform can load such a module at all is found out once (`canImportModules`).
 */
export function codeArtifact<T>(
  spec: CodeArtifactSpec<T>,
  options: ModuleImportOptions = {},
): UpdateArtifact<T> {
  let loadable: Promise<boolean> | undefined
  return {
    kind: spec.kind,
    file: spec.file,
    api: spec.api,
    maxBytes: spec.maxBytes ?? DEFAULT_CODE_MAX_BYTES,
    executable: true,
    bundledVersion: spec.bundledVersion,
    async load(bytes, statement) {
      return spec.accept(await importModuleFromBytes(bytes, options), statement)
    },
    activate: (value, info) => spec.activate(value, info),
    useBundled: () => spec.useBundled(),
    canLoad: () => {
      loadable ??= canImportModules(options)
      return loadable
    },
    ...hooks(spec),
  }
}
