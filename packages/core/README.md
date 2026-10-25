# @fxm/core

The vocabulary every FXM app shares: domain types (tracks, albums, artists, playlists), provider interfaces, the catalog-mode policy, the queue, the matching engine, the playback policy and the recommendation engine.

**Rules**

- Pure TypeScript only. No DOM and no Node APIs, so the same code runs in the browser, the Android WebView, Cloudflare Workers and Node. The `tsconfig.json` enforces this by loading only the ES library.
- No runtime dependencies unless they are small, pure and justified.
- Every export has TSDoc, and logic has offline unit tests.

See [ARCHITECTURE.md §7](../../docs/ARCHITECTURE.md#7-core-concepts).
