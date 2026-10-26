import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Checks the Android evaluator host (EvaluatorPlugin.java) against the web app's side of it, as
// plain text: these tests need no JDK. The WebView itself can only be checked on a device.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const javaDir = 'android/app/src/main/java/io/github/pratyayops/fxm'
// Without comments, so commented-out code can't pass a test (a URL's // is no comment).
const withoutComments = (java: string) => java.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
const plugin = withoutComments(read(`${javaDir}/evaluator/EvaluatorPlugin.java`))
const pin = withoutComments(read(`${javaDir}/evaluator/EvaluatorDocument.java`))
const activity = withoutComments(read(`${javaDir}/MainActivity.java`))
const fxmPlayer = withoutComments(
  read('android/fxm-player/src/main/kotlin/io/github/pratyayops/fxm/player/FxmPlayerPlugin.kt'),
)
const appGradle = read('android/app/build.gradle')
const platformHost = read('../../packages/platform/src/evaluator/capacitor.ts')

/** The body of the Java method `name`, up to the next method or class member. */
const body = (name: string) => plugin.slice(plugin.indexOf(name))

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

  it("loads only the document it was built with, at YouTube's origin, and nothing from the network", () => {
    expect(plugin).toContain('BASE_URL = "https://www.youtube.com/"')
    expect(platformHost).toContain("CAPACITOR_EVALUATOR_ORIGIN = 'https://www.youtube.com'")
    expect(plugin).toMatch(/EvaluatorDocument\.SHA256\.equals\(sha256\(html\)\)/)
    expect(pin).toMatch(/static final String SHA256 = "[0-9a-f]{64}";/)
    expect(plugin).toMatch(/loadDataWithBaseURL\(BASE_URL, html, "text\/html", "utf-8", null\)/)
    expect(plugin).toContain('setBlockNetworkLoads(true)')
    expect(plugin).toContain('setAllowFileAccess(false)')
    expect(plugin).toContain('setAllowContentAccess(false)')
    expect(plugin).toContain('setDomStorageEnabled(false)')
  })

  it('refuses every navigation and every new window', () => {
    expect(body('shouldOverrideUrlLoading(WebView view, WebResourceRequest request)')).toMatch(
      /^[^}]*return true;/,
    )
    expect(body('public boolean onCreateWindow(')).toMatch(/^[^}]*return false;/)
    expect(plugin).toContain('setSupportMultipleWindows(false)')
  })

  it("runs in a profile of its own, cleared on open and close, or doesn't open", () => {
    expect(plugin).toContain('PROFILE = "fxm-evaluator"')
    const created = body('private WebView createWebView()')
    expect(created.indexOf('WebViewCompat.setProfile(view, PROFILE)')).toBeGreaterThan(-1)
    expect(created.indexOf('WebViewCompat.setProfile(view, PROFILE)')).toBeLessThan(
      created.indexOf('view.getSettings()'),
    )
    expect(body('public void open(PluginCall call)')).toMatch(
      /isFeatureSupported\(WebViewFeature\.MULTI_PROFILE\)[\s\S]*call\.reject\(/,
    )
    expect(plugin).toContain('getCookieManager().removeAllCookies(null)')
    expect(plugin).toContain('getWebStorage().deleteAllData()')
    expect(appGradle).toContain('implementation "androidx.webkit:webkit:$androidxWebkitVersion"')
  })

  it('keeps the app alive when the shared renderer dies, and ends a hung one', () => {
    // The evaluator's own handler says the death was handled, so Android doesn't kill the app.
    const handlers = plugin.split('public boolean onRenderProcessGone(').slice(1)
    expect(handlers).toHaveLength(1)
    const code = handlers[0]?.split('@Override')[0] ?? ''
    expect(code).toContain('destroyWebView(')
    expect(code).toContain('return true;')
    expect(code).not.toContain('return false;')
    // The app's own WebView is stage 6.3's: the FxmPlayer plugin, always registered, says its
    // death was handled too and lets WebViewRecovery recreate the activity, spacing out restarts.
    // A second restart from here would undo that spacing.
    expect(plugin).not.toContain('addWebViewListener(')
    expect(plugin).not.toContain('.recreate()')
    expect(activity).toContain('registerPlugin(FxmPlayerPlugin.class)')
    expect(fxmPlayer).toContain('bridge.addWebViewListener(renderer)')
    expect(fxmPlayer).toContain('WebViewRecovery::onRendererGone')
    expect(plugin).toContain('renderer.terminate()')
  })

  it('gives the page no JavaScript interface: the app only reads it', () => {
    expect(plugin).not.toContain('addJavascriptInterface')
    expect(plugin).toContain('evaluateJavascript(script')
  })
})
