/**
 * The evaluator in the Android app: a separate WebView that the app's `FxmEvaluator` plugin
 * (`apps/mobile/android/.../evaluator/EvaluatorPlugin.java`) creates and never attaches to the
 * screen, following the pattern NewPipe documents for its PoTokenWebView. The plugin loads
 * `eval.html` with `https://www.youtube.com/` as the base URL and network loads blocked: the
 * document's own `<meta>` policy allows no connections, and BotGuard sees the location it expects.
 * The WebView shares nothing with the app's page but the process.
 *
 * The app's page drives it through three plugin methods: `open` loads the document, `eval` runs a
 * script and answers the result as JSON text (`evaluateJavascript`), and `close` destroys the
 * WebView. The protocol on top is the mailbox of `mailbox.ts`.
 *
 * @module
 */

import { type CreateEvaluatorOptions, createEvaluator, type Evaluator } from './evaluator'
import { createMailboxPort, type MailboxPortOptions } from './mailbox'

/** The name the Android plugin registers under. */
export const CAPACITOR_EVALUATOR_PLUGIN = 'FxmEvaluator'

/** The Android plugin, as `registerPlugin('FxmEvaluator')` of `@capacitor/core` returns it. */
export interface CapacitorEvaluatorPlugin {
  /** Creates the WebView (again) and loads `html` with the YouTube base URL. */
  open(options: { html: string }): Promise<unknown>
  /** Runs `script` in the WebView; `result` is its value as JSON text. */
  eval(options: { script: string }): Promise<{ result?: unknown }>
  /** Destroys the WebView. */
  close(): Promise<unknown>
}

/** Options for {@link createCapacitorEvaluator}. */
export interface CapacitorEvaluatorOptions
  extends CreateEvaluatorOptions,
    Pick<MailboxPortOptions, 'pollMs' | 'maxPollMs'> {
  /** The plugin. */
  plugin: CapacitorEvaluatorPlugin
  /** The evaluator document, `apps/web/sandbox/eval.html`, as text. */
  html: string
}

/** Creates the Android evaluator. */
export function createCapacitorEvaluator(options: CapacitorEvaluatorOptions): Evaluator {
  const { plugin, html } = options
  const port = createMailboxPort({
    async run(script) {
      const { result } = await plugin.eval({ script })
      return typeof result === 'string' ? result : 'null'
    },
    async start() {
      await plugin.open({ html })
    },
    stop() {
      plugin.close().catch(() => {})
    },
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.maxPollMs === undefined ? {} : { maxPollMs: options.maxPollMs }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
  return createEvaluator('android', port, options)
}
