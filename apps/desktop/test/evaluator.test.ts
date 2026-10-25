import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Checks the desktop app's evaluator host (src-tauri/src/evaluator.rs) against the rest of the
// repo, as plain text, so this runs in `make test` without a Rust toolchain. Its behaviour is
// tested by `cargo test` (make desktop-check).

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const evaluatorRs = read('../src-tauri/src/evaluator.rs')
const libRs = read('../src-tauri/src/lib.rs').replace(/\/\/.*$/gm, '')
const buildRs = read('../src-tauri/build.rs').replace(/\/\/.*$/gm, '')
const config = JSON.parse(read('../src-tauri/tauri.conf.json')) as {
  app: { security: { csp: string } }
}
const capability = JSON.parse(read('../src-tauri/capabilities/default.json')) as {
  windows: string[]
  permissions: unknown[]
}
const platformHost = read('../../../packages/platform/src/evaluator/tauri.ts')

describe('the desktop evaluator host', () => {
  it('embeds the evaluator document that packages/platform builds', () => {
    const path = /include_str!\("([^"]+)"\)/.exec(evaluatorRs)?.[1]
    expect(path).toBe('../../../web/sandbox/eval.html')
    expect(existsSync(new URL(`../src-tauri/src/${path}`, import.meta.url))).toBe(true)
  })

  it('serves it from its own scheme, to a window no capability names', () => {
    expect(evaluatorRs).toContain('pub const SCHEME: &str = "fxm-eval";')
    expect(evaluatorRs).toContain('pub const WINDOW: &str = "fxm-evaluator";')
    expect(capability.windows).toEqual(['main'])
    expect(capability.permissions).toContain('fxm-evaluator:default')
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

  it("leaves 'unsafe-eval' out of the main window's policy", () => {
    expect(config.app.security.csp).not.toContain("'unsafe-eval'")
  })
})
