// FXM's isolation hook (stage 7.2). Tauri's isolation pattern (`app.security.pattern` in
// src-tauri/tauri.conf.json) loads this file into a sandboxed iframe and calls the hook with a
// structured clone of every IPC message the page posts there. The frame then serializes the
// payload the hook returns (tauri's scripts/process-ipc-message-fn.js) and encrypts it with a key
// only the frame has. Rust decrypts every payload with that key and refuses one it can't, so each
// payload Rust reads has passed this hook. Two exceptions: a request with no payload at all skips
// the key, but gives a command no arguments, so it can't carry a request for the HTTP plugin; and
// the start-up gap described at the end.
//
// Only the payload is encrypted: the command and the payload's content type travel in the clear,
// so page script can resend an encrypted payload under another command, or have bytes read as
// JSON. The hook therefore judges every message as a request to tauri-plugin-http
// (`plugin:http|fetch`, whose `clientConfig` argument holds the request), whatever its command:
//
// - A payload Tauri sends as bytes (an array, an ArrayBuffer, a typed array or a DataView) could
//   hold any JSON, so it is replaced with one the plugin refuses. No FXM command takes bytes.
// - Any other payload is first converted as Tauri's serializer converts it (a Map becomes an
//   object, a Uint8Array or an ArrayBuffer an array of numbers), so the rules below apply to
//   exactly the JSON Rust reads. One that Tauri couldn't send (a cycle, a BigInt) is refused too.
// - A `clientConfig` that isn't an object is replaced with a value the plugin refuses: serde also
//   reads the request from an array, field by field, `proxy` included. An object keeps only the
//   fields FXM uses (REQUEST_FIELDS): no `proxy`, with which page script could make Rust connect
//   to any address and port, the user's own network included, no `danger` (TLS exceptions), and
//   nothing a later plugin release adds. Its headers lose Cookie, Cookie2, Host and Proxy-*, and
//   get exactly one Origin: the https: origin of a real site, else '' (which the plugin, built
//   with `unsafe-headers`, sends as no Origin at all), never the webview's own.
//
// Start-up gap: Tauri's own script comes first in the frame's page and handles messages as soon as
// it has imported its key. This file is the next script, so the hook is in place before the first
// message unless the browser pauses between the two scripts, as it may when parsing runs long. A
// message handled in that pause would skip the hook (see "The isolation hook" in the README).
//
// `siteOrigin` must match the one in packages/platform/src/desktop.ts. test/isolation.test.ts
// runs both on the same inputs, and runs this hook with a copy of Tauri's serializer to check what
// Rust reads for every kind of message.
;(() => {
  // The fields of the plugin's request (`ClientConfig` in tauri-plugin-http) that FXM sends.
  const REQUEST_FIELDS = new Set([
    'method',
    'url',
    'headers',
    'data',
    'maxRedirections',
    'connectTimeout',
  ])
  const DROPPED_HEADERS = new Set(['cookie', 'cookie2', 'host'])
  // Tauri's serializer calls the method an object keeps under this key. A structured clone
  // carries no functions, so on a message the frame received, the serializer could only throw.
  const TO_IPC = '__TAURI_TO_IPC_KEY__'
  // What takes the place of a refused request: the plugin's error then names the reason.
  const REFUSED = 'refused by the FXM isolation hook'
  const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

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

  /** Whether Tauri's serializer sends `payload` as bytes rather than as JSON. */
  function sentAsBytes(payload) {
    return payload instanceof ArrayBuffer || ArrayBuffer.isView(payload) || Array.isArray(payload)
  }

  /** The conversions of Tauri's serializer, as a JSON.stringify replacer. */
  function ipcValue(_key, value) {
    if (value instanceof Uint8Array) return Array.from(value)
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
    const converted = value instanceof Map ? Object.fromEntries(value.entries()) : value
    if (typeof converted === 'object' && converted !== null && TO_IPC in converted) {
      throw new TypeError(`a payload can't hold ${TO_IPC}`)
    }
    return converted
  }

  /** The request in a `clientConfig`, as the rules above allow it, its fields in their order. */
  function allowedRequest(config) {
    if (!isObject(config)) return REFUSED
    const request = {}
    for (const [field, value] of Object.entries(config)) {
      if (REQUEST_FIELDS.has(field)) request[field] = value
    }
    request.headers = allowedHeaders(config.headers)
    return request
  }

  /** The payload the frame encrypts instead of `payload`: plain JSON data the rules allow. */
  function allowedPayload(payload) {
    const refused = { clientConfig: REFUSED }
    if (sentAsBytes(payload)) return refused
    let data
    try {
      const json = JSON.stringify(payload, ipcValue)
      data = json === undefined ? undefined : JSON.parse(json)
    } catch {
      return refused
    }
    if (isObject(data) && Object.hasOwn(data, 'clientConfig')) {
      data.clientConfig = allowedRequest(data.clientConfig)
    }
    return data
  }

  window.__TAURI_ISOLATION_HOOK__ = (message) => {
    message.payload = allowedPayload(message.payload)
    return message
  }
})()
