/**
 * Where plugin code runs: documents of the isolated evaluator of stage 1.11
 * (`createSandboxEvaluator`, `createTauriEvaluator`, `createCapacitorEvaluator` of
 * `@fxm/platform`), never FXM's own page. Each plugin gets a document of its own, so one plugin
 * can't read or change another's state, nor the experimental YouTube rungs'.
 *
 * - {@link isolatedSandboxes}: one evaluator per plugin, side by side. The web's evaluator frames
 *   a new opaque-origin document for each, so this is the web's choice.
 * - {@link exclusiveSandbox}: one document at a time, for hosts that can run only one: the
 *   desktop and Android evaluator plugins of 1.11 open a new document by destroying the last.
 *   Each operation holds the document for its plugin; another plugin's operation waits, then
 *   gets a fresh document.
 *
 * @module
 */

import type { Evaluator } from '@fxm/platform'
import { PluginError } from './errors'

/** The part of an `Evaluator` the plugin host uses. */
export type PluginEvaluator = Pick<Evaluator, 'evaluate' | 'dispose'>

/** A plugin's document, lent for one operation. */
export interface SandboxLease {
  /** The evaluator whose document runs only this plugin's code during the lease. */
  readonly evaluator: PluginEvaluator
  /** Gives the document back. Call it once the operation ended, whatever the outcome. */
  release(): void
}

/** Where plugins run. */
export interface PluginSandboxes {
  /**
   * Lends the plugin's document for one operation (several operations of one plugin may hold
   * it at once). Rejects with the signal's reason when `signal` aborts while it waits, and with
   * a `disabled` `PluginError` once disposed.
   */
  acquire(pluginId: string, options?: { readonly signal?: AbortSignal }): Promise<SandboxLease>
  /**
   * Stops the plugin's document, at once or as soon as its operations end: when the plugin is
   * switched off, removed or updated. The next operation starts a new one.
   */
  stop(pluginId: string): void
  /** Stops every document. */
  dispose(): void
}

function disposedError(): PluginError {
  return new PluginError('disabled', 'Plugins were shut down')
}

/** One lease that releases once. */
function lease(evaluator: PluginEvaluator, onRelease: () => void): SandboxLease {
  let released = false
  return {
    evaluator,
    release() {
      if (released) return
      released = true
      onRelease()
    },
  }
}

/**
 * One evaluator per plugin, created on its first operation by `create`: the web's
 * `() => createSandboxEvaluator()`, which frames a document of its own each time.
 */
export function isolatedSandboxes(create: (pluginId: string) => PluginEvaluator): PluginSandboxes {
  interface Entry {
    readonly evaluator: PluginEvaluator
    active: number
    retiring: boolean
  }
  const documents = new Map<string, Entry>()
  /** Stopped documents whose operations still run: disposed as the last one ends. */
  const retiring = new Set<Entry>()
  let disposed = false

  return {
    async acquire(pluginId, options = {}) {
      options.signal?.throwIfAborted()
      if (disposed) throw disposedError()
      let entry = documents.get(pluginId)
      if (entry === undefined) {
        entry = { evaluator: create(pluginId), active: 0, retiring: false }
        documents.set(pluginId, entry)
      }
      const held = entry
      held.active += 1
      return lease(held.evaluator, () => {
        held.active -= 1
        if (held.retiring && held.active === 0) {
          retiring.delete(held)
          held.evaluator.dispose()
        }
      })
    },
    stop(pluginId) {
      const entry = documents.get(pluginId)
      if (entry === undefined) return
      documents.delete(pluginId)
      if (entry.active === 0) {
        entry.evaluator.dispose()
      } else {
        // Its operations end on the old document; the next one starts a new document.
        entry.retiring = true
        retiring.add(entry)
      }
    },
    dispose() {
      disposed = true
      for (const entry of [...documents.values(), ...retiring]) entry.evaluator.dispose()
      documents.clear()
      retiring.clear()
    },
  }
}

interface ExclusiveWaiter {
  readonly pluginId: string
  readonly resolve: (lease: SandboxLease) => void
  readonly reject: (reason: unknown) => void
  readonly signal: AbortSignal | undefined
  readonly onAbort: () => void
}

/**
 * One document at a time, created by `create` (on desktop `() => createTauriEvaluator({ invoke })`,
 * on Android `() => createCapacitorEvaluator({ plugin, html })`): before a plugin's operation
 * runs, the document of another plugin is stopped and a new one started. Operations of the
 * plugin whose document runs share it; another plugin's operation waits until they end, and
 * operations that arrive meanwhile queue behind it, so no plugin waits for ever.
 */
export function exclusiveSandbox(create: () => PluginEvaluator): PluginSandboxes {
  let current: { pluginId: string; evaluator: PluginEvaluator; active: number } | undefined
  let stopCurrent = false
  const queue: ExclusiveWaiter[] = []
  let disposed = false

  function grant(pluginId: string): SandboxLease {
    if (current === undefined || current.pluginId !== pluginId || stopCurrent) {
      current?.evaluator.dispose()
      current = { pluginId, evaluator: create(), active: 0 }
      stopCurrent = false
    }
    const holder = current
    holder.active += 1
    return lease(holder.evaluator, () => {
      holder.active -= 1
      if (holder.active === 0) settle()
    })
  }

  /** Runs when the document is idle: stops it if asked to, then serves the queue's head. */
  function settle(): void {
    if (current !== undefined && current.active === 0 && stopCurrent) {
      current.evaluator.dispose()
      current = undefined
      stopCurrent = false
    }
    if (current !== undefined && current.active > 0) return
    const head = queue[0]
    if (head === undefined) return
    // The head and every waiter for the same plugin share the new document.
    for (const waiter of queue.filter((entry) => entry.pluginId === head.pluginId)) {
      queue.splice(queue.indexOf(waiter), 1)
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve(grant(head.pluginId))
    }
  }

  return {
    acquire(pluginId, options = {}) {
      const { signal } = options
      if (signal?.aborted) return Promise.reject(signal.reason)
      if (disposed) return Promise.reject(disposedError())
      const free = current === undefined || current.active === 0
      const same = current?.pluginId === pluginId && !stopCurrent
      if (queue.length === 0 && (free || same)) return Promise.resolve(grant(pluginId))
      return new Promise<SandboxLease>((resolve, reject) => {
        const waiter: ExclusiveWaiter = {
          pluginId,
          resolve,
          reject,
          signal,
          onAbort: () => {
            const index = queue.indexOf(waiter)
            if (index !== -1) queue.splice(index, 1)
            reject(signal?.reason)
            settle()
          },
        }
        signal?.addEventListener('abort', waiter.onAbort, { once: true })
        queue.push(waiter)
      })
    },
    stop(pluginId) {
      if (current?.pluginId !== pluginId) return
      if (current.active === 0) {
        current.evaluator.dispose()
        current = undefined
        stopCurrent = false
        settle()
      } else {
        stopCurrent = true
      }
    },
    dispose() {
      disposed = true
      current?.evaluator.dispose()
      current = undefined
      for (const waiter of queue.splice(0)) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort)
        waiter.reject(disposedError())
      }
    },
  }
}
