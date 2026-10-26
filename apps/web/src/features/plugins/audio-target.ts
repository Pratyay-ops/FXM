/**
 * Where the plugins' resolvers go: the app's stream lifecycle, which the composition root
 * (`app/services/index.ts`) connects with {@link connectPluginAudio} when it starts. The plugin
 * runtime (`runtime.ts`) follows it: it adds the resolver of every plugin that is on to the target
 * (`addSource`), and takes each out again when its plugin is switched off, updated or removed, or
 * when the target is disconnected. This module stays tiny, so the services' chunk doesn't load
 * the plugin system.
 *
 * @module
 */

import type { StreamSource } from '@fxm/player'

/** Where the plugins' resolvers go: the app's stream lifecycle (`StreamLifecycle.addSource`). */
export interface PluginAudioTarget {
  /** Adds a stream source; returns the function that removes it. */
  addSource(source: StreamSource): () => void
}

let target: PluginAudioTarget | undefined
const listeners = new Set<() => void>()

function setTarget(next: PluginAudioTarget | undefined): void {
  if (next === target) return
  target = next
  for (const listener of [...listeners]) listener()
}

/** The target the plugins' resolvers go to now, if one is connected. */
export function pluginAudioTarget(): PluginAudioTarget | undefined {
  return target
}

/** Calls `listener` whenever the target changes. Returns the function that stops it. */
export function subscribePluginAudioTarget(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Makes `next` the target of the plugins' resolvers, in place of any other: the composition root
 * connects the app's stream lifecycle. Returns the function that disconnects it, if it is still
 * the target.
 */
export function connectPluginAudio(next: PluginAudioTarget): () => void {
  setTarget(next)
  return () => {
    if (target === next) setTarget(undefined)
  }
}

/** Disconnects any target: for tests, which each start without one. */
export function resetPluginAudioTarget(): void {
  setTarget(undefined)
}
