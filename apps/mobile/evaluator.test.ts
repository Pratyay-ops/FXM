import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Checks the Android evaluator host (EvaluatorPlugin.java) against the web app's side of it, as
// plain text: these tests need no JDK. The WebView itself can only be checked on a device.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const javaDir = 'android/app/src/main/java/io/github/pratyayops/fxm'
// Without comments, so commented-out code can't pass a test (a URL's // is no comment).
const withoutComments = (java: string) => java.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
const plugin = withoutComments(read(`${javaDir}/evaluator/EvaluatorPlugin.java`))
const activity = withoutComments(read(`${javaDir}/MainActivity.java`))
const platformHost = read('../../packages/platform/src/evaluator/capacitor.ts')

describe('the Android evaluator host', () => {
  it('is registered before the bridge starts', () => {
    const register = activity.indexOf('registerPlugin(EvaluatorPlugin.class)')
    expect(register).toBeGreaterThan(-1)
    expect(register).toBeLessThan(activity.indexOf('super.onCreate'))
  })

  it("answers to the name and methods the web app's host calls", () => {
    expect(plugin).toContain('@CapacitorPlugin(name = "FxmEvaluator")')
    expect(platformHost).toContain("CAPACITOR_EVALUATOR_PLUGIN = 'FxmEvaluator'")
    for (const method of ['open', 'eval', 'close']) {
      expect(plugin).toMatch(
        new RegExp(`@PluginMethod\\s+public void ${method}\\(PluginCall call\\)`),
      )
      expect(platformHost).toContain(`plugin.${method}(`)
    }
    expect(plugin).toContain('result.put("result", value)')
  })

  it("loads the document with YouTube's origin, and nothing from the network", () => {
    expect(plugin).toContain('BASE_URL = "https://www.youtube.com/"')
    expect(plugin).toMatch(/loadDataWithBaseURL\(BASE_URL, html, "text\/html", "utf-8", null\)/)
    expect(plugin).toContain('setBlockNetworkLoads(true)')
    expect(plugin).toContain('setAllowFileAccess(false)')
    expect(plugin).toContain('setAllowContentAccess(false)')
    expect(plugin).toContain('setDomStorageEnabled(false)')
  })

  it('gives the page no JavaScript interface: the app only reads it', () => {
    expect(plugin).not.toContain('addJavascriptInterface')
    expect(plugin).toContain('evaluateJavascript(script')
  })
})
