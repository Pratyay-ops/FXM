import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Checks the desktop app's evaluator host (src-tauri/src/evaluator.rs) against the rest of the
// repo, as plain text, so this runs in `make test` without a Rust toolchain. Its behaviour is
// tested by `cargo test` (make desktop-check).

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const withoutComments = (rust: string) => rust.replace(/\/\/.*$/gm, '')

const evaluatorRs = withoutComments(read('../src-tauri/src/evaluator.rs'))
const libRs = withoutComments(read('../src-tauri/src/lib.rs'))
const buildRs = withoutComments(read('../src-tauri/build.rs'))
const sources = readdirSync(new URL('../src-tauri/src/', import.meta.url))
  .filter((name) => name.endsWith('.rs'))
  .map((name) => ({ name, text: withoutComments(read(`../src-tauri/src/${name}`)) }))
const config = JSON.parse(read('../src-tauri/tauri.conf.json')) as {
  app: { security: { csp: string } }
}
const capability = JSON.parse(read('../src-tauri/capabilities/default.json')) as {
  windows?: string[]
  webviews: string[]
  permissions: unknown[]
}
const platformHost = read('../../../packages/platform/src/evaluator/tauri.ts')

describe('the desktop evaluator host', () => {
  it('embeds the evaluator document that packages/platform builds', () => {
    const path = /include_str!\("([^"]+)"\)/.exec(evaluatorRs)?.[1]
    expect(path).toBe('../../../web/sandbox/eval.html')
    expect(existsSync(new URL(`../src-tauri/src/${path}`, import.meta.url))).toBe(true)
  })

  it('serves it from its own scheme, to windows no capability names', () => {
    expect(evaluatorRs).toContain('pub const SCHEME: &str = "fxm-eval";')
    expect(evaluatorRs).toContain('pub const WINDOW_PREFIX: &str = "fxm-evaluator-";')
    // The capability names the main window's webview only, which has that window's label; an
    // evaluator window's webview has the evaluator window's.
    expect(capability.webviews).toEqual(['main'])
    expect(capability.windows).toBeUndefined()
    expect(capability.permissions).toContain('fxm-evaluator:default')
    expect(platformHost).toContain("TAURI_EVALUATOR_ORIGIN = 'fxm-eval://localhost'")
  })

  it('keeps each window on its document: no navigation, no new windows', () => {
    expect(evaluatorRs).toMatch(/\.on_navigation\(is_document_url\)/)
    expect(evaluatorRs).toMatch(/\.on_new_window\(\|_, _\| NewWindowResponse::Deny\)/)
    // eval reads only a window that still shows the document.
    expect(evaluatorRs).toMatch(
      /window\s*\.url\(\)\s*\.is_ok_and\(\|url\| is_document_url\(&url\)\)/,
    )
  })

  it('destroys the evaluator window with the main window, so closing that one still quits', () => {
    expect(evaluatorRs).toMatch(/\.on_event\(/)
    expect(evaluatorRs).toMatch(/RunEvent::WindowEvent \{ label, event, \.\. \}/)
    expect(evaluatorRs).toMatch(/ends_main_window\(label, event\)/)
    expect(evaluatorRs).toMatch(
      /label == crate::MAIN_WINDOW && matches!\(event, WindowEvent::Destroyed\)/,
    )
  })

  it('registers the plugin with exactly the commands the web app calls', () => {
    expect(libRs).toMatch(/\.plugin\(\s*evaluator::init\(\)\s*\)/)
    const declared = /\.commands\(&\[([^\]]*)\]\)/.exec(buildRs)?.[1]
    const commands = [...(declared ?? '').matchAll(/"([^"]+)"/g)].map(([, name]) => name)
    expect(commands.sort()).toEqual(['close', 'eval', 'open'])
    expect(evaluatorRs).toMatch(/generate_handler!\[open, eval, close\]/)
    expect(platformHost).toContain("TAURI_EVALUATOR_PLUGIN = 'fxm-evaluator'")
    for (const command of commands) expect(platformHost).toContain(`command('${command}')`)
  })

  it('registers no app command that the evaluator window could call', () => {
    // Tauri checks app commands (registered on tauri::Builder, not a plugin) against the
    // capabilities only when the app declares an access-control manifest; otherwise any page at
    // a local URL may call them, the evaluator window's fxm-eval: page included. An app command
    // therefore needs `app_manifest(AppManifest::new().commands(&[...]))` in build.rs, with its
    // permission granted to the main window only, before it may be registered.
    const appCommands = sources.filter(
      ({ text }) => text.includes('.invoke_handler(') && !text.includes('plugin::{Builder'),
    )
    const manifest = /app_manifest\(\s*tauri_build::AppManifest::new\(\)\s*\.commands\(/.test(
      buildRs,
    )
    if (!manifest) expect(appCommands.map(({ name }) => name)).toEqual([])
    else expect(capability.webviews).toEqual(['main'])
  })

  it("leaves 'unsafe-eval' out of the main window's policy", () => {
    expect(config.app.security.csp).not.toContain("'unsafe-eval'")
  })
})
