/**
 * Where plugin code runs: documents of the isolated evaluator of stage 1.11
 * (`createSandboxEvaluator` of `@fxm/platform` on the web), never FXM's own page. Each plugin
 * gets a document of its own, which runs its code in a worker of its own (`runtime/document.ts`),
 * so one plugin can't read or change another's state, nor the experimental YouTube rungs'.
 *
 * {@link isolatedSandboxes} gives each plugin an evaluator of its own, side by side: the web's
 * evaluator frames a new opaque-origin document for each. It refuses an evaluator of kind
 * `in-process`, which runs code in the caller's own realm and so isolates nothing, unless a test
 * passes {@link IN_PROCESS_FOR_TESTS} (which `@fxm/plugins/testing` does).
 *
 * The desktop and Android evaluators of 1.11 run one document at a time (opening one destroys the
 * last, whoever opened it), so plugins there wait for an evaluator owner in `@fxm/platform` that
 * leases documents to 1.11's rungs and to plugins alike (see the README).
 *
 * @module
 */

import type { Evaluator } from '@fxm/platform'
import { PluginError } from './errors'

/** The part of an `Evaluator` the plugin host uses. */
export type PluginEvaluator = Pick<Evaluator, 'kind' | 'evaluate' | 'dispose'>

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

/**
 * The option that lets {@link isolatedSandboxes} take in-process evaluators: for tests only,
 * where the plugin's worker runs in a realm of the test process (see `@fxm/plugins/testing`).
 */
export const IN_PROCESS_FOR_TESTS: unique symbol = Symbol('fxm.plugins.inProcessForTests')

/** Options for {@link isolatedSandboxes}. */
export interface SandboxOptions {
  /** Tests only: take evaluators of kind `in-process`. */
  readonly [IN_PROCESS_FOR_TESTS]?: true
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
 * `() => createSandboxEvaluator()`, which frames a document of its own each time. An evaluator of
 * kind `in-process` is disposed at once, and the operation fails with `unavailable`: it would run
 * the plugin in the page.
 */
export function isolatedSandboxes(
  create: (pluginId: string) => PluginEvaluator,
  options: SandboxOptions = {},
): PluginSandboxes {
  interface Entry {
    readonly evaluator: PluginEvaluator
    active: number
    retiring: boolean
  }
  const documents = new Map<string, Entry>()
  /** Stopped documents whose operations still run: disposed as the last one ends. */
  const retiring = new Set<Entry>()
  const inProcess = options[IN_PROCESS_FOR_TESTS] === true
  let disposed = false

  return {
    async acquire(pluginId, acquireOptions = {}) {
      acquireOptions.signal?.throwIfAborted()
      if (disposed) throw disposedError()
      let entry = documents.get(pluginId)
      if (entry === undefined) {
        const evaluator = create(pluginId)
        if (evaluator.kind === 'in-process' && !inProcess) {
          evaluator.dispose()
          throw new PluginError(
            'unavailable',
            'Plugins run only in an isolated evaluator, never in the page itself',
          )
        }
        entry = { evaluator, active: 0, retiring: false }
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
