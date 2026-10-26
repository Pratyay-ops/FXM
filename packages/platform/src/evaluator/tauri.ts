/**
 * The evaluator in the desktop app. Tauri applies one app-wide policy to the pages it serves from
 * its asset protocol, and a `<meta>` policy can only tighten it, so the main window's policy
 * cannot allow `'unsafe-eval'` for the evaluator alone. Instead, the app's `fxm-evaluator` plugin
 * (`apps/desktop/src-tauri/src/evaluator.rs`) opens a second, hidden webview window on a custom
 * URI scheme, `fxm-eval://localhost/eval.html`, whose Rust handler serves `eval.html` with its
 * own policy. No capability names that window, so its page can call no plugin command, and the
 * app registers no command of its own (`apps/desktop/test/evaluator.test.ts` fails if one comes
 * without an access-control manifest). It can't navigate away from its document.
 *
 * The main window drives it through three plugin commands: `open` creates a new window (and
 * destroys any earlier one), `eval` runs a script in it and answers the result as JSON text
 * (`eval_with_callback`), and `close` destroys it. The protocol on top is the mailbox of
 * `mailbox.ts`.
 *
 * @module
 */

import type { TauriInvoke } from '../desktop'
import { type CreateEvaluatorOptions, createEvaluator, type Evaluator } from './evaluator'
import { createMailboxPort, type MailboxPortOptions } from './mailbox'

/** The desktop plugin that hosts the evaluator. */
export const TAURI_EVALUATOR_PLUGIN = 'fxm-evaluator'

/**
 * Where the desktop's evaluator document runs: its own scheme. Windows' webview names the same
 * place `http://fxm-eval.localhost` (`https://` where the app asks for it).
 */
export const TAURI_EVALUATOR_ORIGIN = 'fxm-eval://localhost'

/** Options for {@link createTauriEvaluator}. */
export interface TauriEvaluatorOptions
  extends CreateEvaluatorOptions,
    Pick<MailboxPortOptions, 'pollMs' | 'maxPollMs'> {
  /** Tauri's `invoke`, as `loadTauriBindings()` gives it. */
  invoke: TauriInvoke
}

/** Creates the desktop evaluator. */
export function createTauriEvaluator(options: TauriEvaluatorOptions): Evaluator {
  const { invoke } = options
  const command = (name: string) => `plugin:${TAURI_EVALUATOR_PLUGIN}|${name}`
  const port = createMailboxPort({
    async run(script) {
      const result = await invoke<unknown>(command('eval'), { script })
      return typeof result === 'string' ? result : 'null'
    },
    async start() {
      await invoke(command('open'))
    },
    stop() {
      invoke(command('close')).catch(() => {})
    },
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.maxPollMs === undefined ? {} : { maxPollMs: options.maxPollMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
  return createEvaluator('desktop', port, {
    ...options,
    origin: TAURI_EVALUATOR_ORIGIN,
    alsoAccept: ['http://fxm-eval.localhost', 'https://fxm-eval.localhost'],
  })
}
