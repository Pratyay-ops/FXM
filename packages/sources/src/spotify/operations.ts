/**
 * The registry of GraphQL operations: which ones the config enables (those with a cleanly
 * sourced persisted-query hash) and which ones Spotify rejected during this session.
 *
 * An operation Spotify answers with HTTP 412 ("Invalid query hash"), or whose variables it no
 * longer accepts, is marked broken until the provider is recreated or
 * {@link OperationRegistry.reset} is called, so FXM never retries it in a loop; a newer config
 * with a new hash fixes it.
 *
 * @module
 */

import type { SpotifyConfig, SpotifyOperationName } from './config'
import { SpotifyError } from './errors'

/** The operations of one config and their state in this session. */
export class OperationRegistry {
  readonly #config: SpotifyConfig
  readonly #broken = new Set<SpotifyOperationName>()
  readonly #onChange: (() => void) | undefined

  /**
   * @param config Where the hashes come from.
   * @param onChange Called when an operation is marked broken or the marks are reset.
   */
  constructor(config: SpotifyConfig, onChange?: () => void) {
    this.#config = config
    this.#onChange = onChange
  }

  /**
   * The persisted-query hash to send for `name`.
   *
   * @throws SpotifyError `Unsupported` (`operation-unavailable`) when the config has no hash for
   * it, `Unavailable` (`operation-broken`) when Spotify rejected it this session.
   */
  hashOf(name: SpotifyOperationName): string {
    const hash = this.#config.operations[name]?.sha256Hash
    if (hash === undefined) {
      throw new SpotifyError(
        'Unsupported',
        'operation-unavailable',
        `The Spotify operation ${name} has no cleanly sourced hash in this config`,
      )
    }
    if (this.#broken.has(name)) {
      throw new SpotifyError(
        'Unavailable',
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

  /** Marks `name` broken for the rest of the session. */
  markBroken(name: SpotifyOperationName): void {
    if (this.#broken.has(name)) return
    this.#broken.add(name)
    this.#onChange?.()
  }

  /** The operations marked broken, in the order they broke. */
  broken(): SpotifyOperationName[] {
    return [...this.#broken]
  }

  /** Forgets every broken mark. */
  reset(): void {
    if (this.#broken.size === 0) return
    this.#broken.clear()
    this.#onChange?.()
  }
}
