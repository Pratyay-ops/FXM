/**
 * The playback policy (stage 2.3): the pure rules for which audio plays a track, how a stream is
 * chosen, what happens when it fails, and when Smart Replace swaps a match. The stateful stream
 * lifecycle that applies them (URL cache, probes, prefetch) is `StreamLifecycle` in
 * `@fxm/player`. See `README.md` in this folder.
 *
 * @module
 */

export * from './order'
export * from './problems'
export * from './recovery'
export * from './settings'
export * from './streams'
