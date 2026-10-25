// FXM's isolation hook (stage 7.2). Tauri's isolation pattern (`app.security.pattern` in
// src-tauri/tauri.conf.json) runs this file in a sandboxed iframe of its own origin and hands it
// every IPC message a page sends. The frame then encrypts the message for Rust with a key only it
// has, and Rust refuses anything else, so no page script reaches Rust around this hook.
//
// For every request to tauri-plugin-http (`plugin:http|fetch`), whoever sends it, it applies the
// rules that createDesktopFetch (packages/platform/src/desktop.ts) applies to FXM's own requests:
//
// - no per-request `proxy`, which would let page script open a connection to any address and port,
//   the user's own network included, and no `danger` (TLS exceptions);
// - no Cookie, Cookie2, Host or Proxy-* header;
// - exactly one Origin: the https: origin of a real site, else '' (which the plugin, built with
//   `unsafe-headers`, sends as no Origin at all), never the webview's own.
//
// Every other message passes unchanged. `siteOrigin` must match the one in desktop.ts:
// test/isolation.test.ts runs both on the same inputs.
;(() => {
  const FETCH = 'plugin:http|fetch'
  const DROPPED_HEADERS = new Set(['cookie', 'cookie2', 'host'])

  /** `value` when it is the https: origin of a real site, else '' (no Origin). */
  function siteOrigin(value) {
    if (typeof value !== 'string' || value === '') return ''
    let url
    try {
      url = new URL(value)
    } catch {
      return ''
    }
    const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
    return url.protocol === 'https:' && !local && url.origin === value ? value : ''
  }

  /** The request's headers as the rules above allow them, with exactly one Origin, last. */
  function allowedHeaders(headers) {
    const kept = []
    let origin = ''
    for (const entry of Array.isArray(headers) ? headers : []) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const [name, value] = entry
      if (typeof name !== 'string' || typeof value !== 'string') continue
      const lower = name.toLowerCase()
      if (lower === 'origin') origin = siteOrigin(value)
      else if (!DROPPED_HEADERS.has(lower) && !lower.startsWith('proxy-')) kept.push([name, value])
    }
    kept.push(['origin', origin])
    return kept
  }

  window.__TAURI_ISOLATION_HOOK__ = (message) => {
    if (message === null || typeof message !== 'object' || message.cmd !== FETCH) return message
    const config = message.payload?.clientConfig
    if (config === null || typeof config !== 'object') return message
    delete config.proxy
    delete config.danger
    config.headers = allowedHeaders(config.headers)
    return message
  }
})()
