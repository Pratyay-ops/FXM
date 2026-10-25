/**
 * The registry of GraphQL operations: which ones the config enables (those with a cleanly
 * sourced persisted-query hash) and which ones Spotify rejected during this session.
 *
 * An operation Spotify answers with HTTP 412 ("Invalid query hash"), or whose variables it no
 * longer accepts, is marked broken, so FXM never retries it in a loop. A newer config with a new
 * hash for it ({@link OperationRegistry.setConfig}) clears the mark; {@link OperationRegistry.reset}
 * clears every mark, e.g. when the user taps "Try again".
 *
 * @module
 */

import type { SpotifyConfig, SpotifyOperationName } from './config'
import { SpotifyError } from './errors'

/** The operations of one config and their state in this session. */
export class OperationRegistry {
  #config: SpotifyConfig
  /** Each broken operation with the hash Spotify rejected. */
  readonly #broken = new Map<SpotifyOperationName, string>()
  readonly #onChange: (() => void) | undefined

  /**
   * @param config Where the hashes come from.
   * @param onChange Called when the broken operations change.
   */
  constructor(config: SpotifyConfig, onChange?: () => void) {
    this.#config = config
    this.#onChange = onChange
  }

  /**
   * The persisted-query hash to send for `name`.
   *
   * @throws SpotifyError `operation-unsupported` when the config has no hash for it,
   * `operation-broken` when Spotify rejected it this session.
   */
  hashOf(name: SpotifyOperationName): string {
    const hash = this.#config.operations[name]?.sha256Hash
    if (hash === undefined) {
      throw new SpotifyError(
        'operation-unsupported',
        `The Spotify operation ${name} has no cleanly sourced hash in this config`,
      )
    }
    if (this.#broken.has(name)) {
      throw new SpotifyError(
        'operation-broken',
        `Spotify rejected the operation ${name} earlier this session; it needs a newer config`,
      )
    }
    return hash
  }

  /** Whether `name` can be called: it has a hash and is not broken. */
  isAvailable(name: SpotifyOperationName): boolean {
    return this.#config.operations[name] !== undefined && !this.#broken.has(name)
  }

  /** Marks `name` broken for the rest of the session, or until its hash changes. */
  markBroken(name: SpotifyOperationName): void {
    const hash = this.#config.operations[name]?.sha256Hash
    if (hash === undefined || this.#broken.has(name)) return
    this.#broken.set(name, hash)
    this.#onChange?.()
  }

  /** The operations marked broken, in the order they broke. */
  broken(): SpotifyOperationName[] {
    return [...this.#broken.keys()]
  }

  /**
   * Uses the hashes of `config` from now on. An operation whose hash changed, or that the config
   * no longer has, loses its broken mark.
   */
  setConfig(config: SpotifyConfig): void {
    this.#config = config
    let changed = false
    for (const [name, hash] of [...this.#broken]) {
      if (config.operations[name]?.sha256Hash !== hash) {
        this.#broken.delete(name)
        changed = true
      }
    }
    if (changed) this.#onChange?.()
  }

  /** Forgets every broken mark. */
  reset(): void {
    if (this.#broken.size === 0) return
    this.#broken.clear()
    this.#onChange?.()
  }
}
