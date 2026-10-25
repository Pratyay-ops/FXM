# @fxm/sources

Provider implementations, one folder per source, each imported by path:

```ts
import { fetchWithTimeout } from '@fxm/sources/shared'
// later: '@fxm/sources/youtube', '@fxm/sources/jiosaavn', '@fxm/sources/archive', …
```

The wildcard `exports` entry (`./*` → `./src/*/index.ts`) means a new provider never edits a shared index file, so parallel stages don't conflict.

**Rules**

- Only `fetch` and web-standard APIs. The same code must run in Cloudflare Workers (the gateway), the Android WebView, browsers and Node. The `tsconfig.json` loads the `webworker` library, so `document` and `window` are type errors.
- Never call the global `fetch`: take it as a parameter (see `shared/fetchWithTimeout`), because each platform injects its own.
- Tests run offline against recorded, sanitized fixtures. Live checks run only with `FXM_LIVE=1`.

See [ARCHITECTURE.md §7.3](../../docs/ARCHITECTURE.md#73-runtime-agnostic-providers).
