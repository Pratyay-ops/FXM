# Signed module e2e test

Stage 1.13's done-when in real browser engines, without the desktop app's Rust build: the harness app (`harness.html`, `harness.mjs`) is built with a deliberately broken parser in its bundled YouTube module, served with the desktop app's Content Security Policy, and updated from a local stand-in for FXM's site with a module signed by a throwaway key. The test checks that:

- the update verifies, loads from a `blob:` URL and fixes the parser, without reloading the page;
- a module whose bytes were changed after signing is refused;
- without `blob:` in `script-src` (the web app's policy) the module can't load, and the app keeps its own.

It is not part of `make test`. Run it with:

```sh
scripts/run.sh pnpm --filter @fxm/platform exec playwright install chromium   # once
scripts/run.sh pnpm --filter @fxm/platform test:e2e
```

Chromium stands in for WebView2 (Windows) and Android System WebView. For WebKit, which stands in for WKWebView (macOS) and WebKitGTK (Linux), install it once (`playwright install webkit`) and set `FXM_E2E_WEBKIT=1`. The server listens on `127.0.0.1:6020` and fails if the port is taken; set `FXM_E2E_PORT` to use another.

## In the desktop app itself

`desktop.mjs` runs the same harness as the frontend of the real desktop shell (`apps/desktop`, Tauri 2), so the module is checked and loaded by the system webview, from `tauri://localhost`, under the app's own Content Security Policy:

```sh
make desktop-setup   # once: the Rust toolchain
scripts/run.sh node --experimental-strip-types --disable-warning=ExperimentalWarning \
  packages/platform/src/updates/e2e/desktop.mjs
```

It builds a debug app (about two and a half minutes the first time, seconds after that), opens a small window for a few seconds and prints the app's report. Only the frontend and `connect-src` (which also allows the local server) differ from the app's configuration; the real app will fetch updates through its native HTTP (stage 7.2). Run on 2026-10-26 on macOS 15 (WKWebView): the bundled parser failed, the signed update was verified with WebCrypto's Ed25519, loaded from a `blob:` URL, and the same provider then resolved the song. On Windows (WebView2) and Linux (WebKitGTK) it hasn't been run yet.
