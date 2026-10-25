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

The real desktop app adds what this test can't: the Tauri webview and native HTTP of stage 7.2. Checking it there is listed as pending in the stage report until 7.2 and the app's use of the YouTube host have merged.
