# Clean-room log: the Lite tier's sandbox (stage 1.10)

The sandbox documents in this folder send requests to InnerTube, an API YouTube does not document, and the tests here play YouTube's media. The [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) asks that every protocol fact the code relies on be recorded, with where it came from and when, in the log of the service it is about. **The YouTube facts this stage relies on are in the YouTube log**, under [The Lite tier: opaque origins (stage 1.10)](../../../sources/src/youtube/CLEAN-ROOM.md#the-lite-tier-opaque-origins-stage-110). This file keeps only what the documents rely on from browsers and web standards.

**Nothing here came from a GPL, AGPL or unlicensed project.** No code, fixture or translated logic was taken from such a project, and nobody worked from one while writing this folder.

## Sources

| Key | Source |
|---|---|
| **Memo** | FXM's research memo, [`docs/research/2026-10-25-userside-memo.md`](../../../../docs/research/2026-10-25-userside-memo.md): live verification runs from a residential connection on 2026-10-25, section named |
| **Standards** | The [Fetch standard](https://fetch.spec.whatwg.org/) (CORS-safelisted request headers, the CORS check, redirect modes), the [HTML standard](https://html.spec.whatwg.org/) (sandboxed documents, `postMessage`, navigating nested frames) and [CSP Level 3](https://www.w3.org/TR/CSP3/) (the `sandbox` and `frame-src` directives) |
| **E2E-26** | This stage's browser tests against the mocks ([`e2e/sandbox.e2e.ts`](e2e/sandbox.e2e.ts)), in Playwright's Chromium 156.0.8078.4 and Firefox 157.0 on macOS 15.5, 2026-10-26 |
| **Review-26** | The first review of this stage, 2026-10-26: a proof of concept in the same two browsers, run outside the repository and confirmed by E2E-26 |

## Browser behaviour the documents rely on

| Fact | Source | Date |
|---|---|---|
| A document served with a CSP `sandbox` directive without `allow-same-origin` has an opaque origin (`self.origin === 'null'`) however it is loaded: at top level, or framed without the `sandbox` attribute | Standards (CSP3 `sandbox`); E2E-26 (both browsers) | 2026-10-26 |
| A sandboxed document still knows its own URL (`location.href`), fragment included, so it knows the origin it was served from and the token the page put in the fragment | Standards (HTML, `Location`); E2E-26 | 2026-10-26 |
| Messages from a sandboxed document arrive with `origin` `'null'`; `postMessage` with a target origin other than the recipient's delivers nothing (Firefox logs an error, Chromium logs nothing the page can see) | Standards (HTML, `postMessage`); E2E-26 | 2026-10-26 |
| A page that frames another site's page can navigate a frame inside it (`frames[0][0].location = …`), as an ancestor of that frame, unless the middle page's `frame-src` forbids the new URL; the new document keeps the frame's sandbox flags, so it too has an opaque origin and its messages arrive from the frame's window with `origin` `'null'` | Standards (HTML, "allowed to navigate"; CSP3 `frame-src`); Review-26; E2E-26 (the swap test, both browsers) | 2026-10-26 |
| A fetch from an opaque origin carries `Origin: null`; with `credentials: 'omit'` it carries no cookie, and with `referrerPolicy: 'no-referrer'` no `Referer` | Standards (Fetch); E2E-26 (the mock's request log) | 2026-10-26 |
| A header outside the CORS safelist (`Content-Type: application/json`, any `X-…`), or a method other than `GET`, `HEAD` and `POST`, makes the browser send a preflight first | Standards (Fetch, "CORS-safelisted request-header"); E2E-26 (the mock saw the `OPTIONS`) | 2026-10-26 |
| With `redirect: 'manual'`, a cross-origin redirect that passes the CORS check (it carries `Access-Control-Allow-Origin`) comes back as an `opaqueredirect` response, and one that does not fails as a network error (`TypeError`); either way the browser does not contact the `Location` host | Standards (Fetch, "HTTP fetch": the CORS check, then the redirect mode); E2E-26 (both browsers; the proxy saw no connection to the second host) | 2026-10-26 |
| Chromium and Firefox ask for a media URL's whole file in their first request (`Range: bytes=0-`), so a URL capped below the file's size fails that request and `<audio>` reports a media error | Memo §3; E2E-26 (both browsers sent `bytes=0-` first and fired `error`) | 2026-10-26 |
