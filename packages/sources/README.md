# @fxm/sources

Provider implementations, one folder per source, each imported by path:

```ts
import { fetchWithTimeout } from '@fxm/sources/shared'
// later: '@fxm/sources/youtube', '@fxm/sources/jiosaavn', '@fxm/sources/archive', …
```

`@fxm/sources/import` is the one folder that is not a provider: imports of other apps' playlists, Spotify's data export and links, matched with the providers' help (see its README).

The wildcard `exports` entry (`./*` → `./src/*/index.ts`) means a new provider never edits a shared index file, so parallel stages don't conflict.

**Rules**

- Only `fetch` and web-standard APIs. The same code must run in Cloudflare Workers (the gateway), the Android WebView, browsers and Node. The `tsconfig.json` loads the `webworker` library, so `document` and `window` are type errors.
- Never call the global `fetch`: take it as a parameter (see `shared/fetchWithTimeout`), because each platform injects its own.
- The oldest engines to support are Safari 16 (iOS 16, where only the free sources play) and the system WebKit of macOS 11, the desktop app's minimum. They lack `AbortSignal.any` (Safari 17.4), and Safari before 16 lacks `AbortSignal.timeout`, so use `fetchWithTimeout`, which falls back to a timer, instead of calling them.
- Tests run offline against recorded, sanitized fixtures. Live checks run only with `FXM_LIVE=1`.

See [ARCHITECTURE.md §7.3](../../docs/ARCHITECTURE.md#73-runtime-agnostic-providers).
