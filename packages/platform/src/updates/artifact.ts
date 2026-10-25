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
import type { UpdateStatement } from './format.ts'
import { importModuleFromBytes, type ModuleImportOptions } from './loader.ts'

/** Where the version in use came from. */
export type UpdateOrigin = 'bundled' | 'stored' | 'fetched'

/** What the updater tells an artifact when it switches to a verified version. */
export interface ActivationInfo {
  /** `stored`: kept from an earlier run; `fetched`: just downloaded. */
  readonly origin: Exclude<UpdateOrigin, 'bundled'>
  /** The version. */
  readonly version: number
}

/**
 * One kind of artifact the updater keeps current. The value type `T` is what `load` makes of
 * the bytes, e.g. a parsed config or a module's exports.
 */
export interface UpdateArtifact<T = unknown> {
  /** Its kind, as signed statements name it, e.g. `youtube-config`. */
  readonly kind: string
  /** Its file name under each update URL, e.g. `youtube-config.json`. */
  readonly file: string
  /** For code: the contract version between the app and the module, which statements carry. */
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
   * used, e.g. a module that fails to load: the updater then keeps what it has and never tries
   * that version again.
   */
  load(bytes: Uint8Array<ArrayBuffer>, statement: UpdateStatement): T | Promise<T>
  /**
   * Switches to a loaded, verified version. It switches completely or, by throwing, not at all;
   * a throw counts as a failed load.
   */
  activate(value: T, info: ActivationInfo): void
  /** Switches back to the version the app ships with. */
  useBundled(): void
}

/** The largest JSON artifact {@link jsonArtifact} accepts by default: 256 KiB. */
export const DEFAULT_JSON_MAX_BYTES = 256 * 1024

/** The largest module {@link codeArtifact} accepts by default: 8 MiB. */
export const DEFAULT_CODE_MAX_BYTES = 8 * 1024 * 1024

/** What {@link jsonArtifact} needs to know about a JSON artifact. */
export interface JsonArtifactSpec<T> {
  /** The kind. */
  readonly kind: string
  /** The file name. */
  readonly file: string
  /** The version the app ships with. */
  readonly bundledVersion: number
  /** The largest file accepted; {@link DEFAULT_JSON_MAX_BYTES} by default. */
  readonly maxBytes?: number
  /** Checks the parsed JSON (and that its own version is the signed one), and returns the value. */
  accept(json: unknown, statement: UpdateStatement): T
  /** See {@link UpdateArtifact.activate}. */
  activate(value: T, info: ActivationInfo): void
  /** See {@link UpdateArtifact.useBundled}. */
  useBundled(): void
}

/** An artifact whose bytes are a UTF-8 JSON document, such as a config. */
export function jsonArtifact<T>(spec: JsonArtifactSpec<T>): UpdateArtifact<T> {
  return {
    kind: spec.kind,
    file: spec.file,
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
}

/**
 * An artifact whose bytes are an ES module, loaded from a `blob:` URL made from the verified
 * bytes (`importModuleFromBytes`). Desktop and Android only: their `script-src` allows `blob:`.
 */
export function codeArtifact<T>(
  spec: CodeArtifactSpec<T>,
  options: ModuleImportOptions = {},
): UpdateArtifact<T> {
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
  }
}
