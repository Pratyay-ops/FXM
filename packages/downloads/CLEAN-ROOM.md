# Clean-room log: download hosts

The facts the download manager (`@fxm/downloads`, stage 4.1) relies on about the hosts it fetches files from, each with its source and date. The rule and the index of logs are in [docs/LEGAL.md](../../docs/LEGAL.md#clean-room-rule). The manager itself is generic: it speaks plain HTTP range requests, and these facts are why its rules look the way they do.

## googlevideo (YouTube's media hosts)

From the [user-side research memo](../../docs/research/2026-10-25-userside-memo.md), sections 4.1 to 4.5, measured 2026-10-25, and from FXM Connect's rules (`apps/extension/src/rules.ts`, [its README](../../apps/extension/README.md)):

| Fact | Where the manager relies on it |
|---|---|
| VISIONOS stream URLs answer a range in the last 64 KB of the file with `206`; the URLs of ANDROID_VR and IOS answer `403` from roughly 0.4 to 2 MiB on ("capped"). ANDROID's itag 18 is served to the last byte | Only URLs the end-of-file probe verified are downloaded (`isDownloadableStream`); a `403` mid-file means "resolve afresh" |
| Stream URLs expire about 6 hours after they are issued (`expire`), and work only from the IP address that resolved them (`ip` in `sparams`) | A URL within a minute of its expiry, or one used across a network change, is resolved afresh; a URL is never stored with a download |
| With FXM Connect, a page can read googlevideo's answers to single-range GETs: Connect sets `Access-Control-Allow-Origin` to the FXM origin and exposes the range headers | The transfer reads `Content-Range` there |
| After a `302` to another googlevideo host, the browser sends `Origin: null`, which no static rule can answer, so the bytes stay unreadable and `fetch` fails without an answer | On the web, a request to a signed (IP-bound) URL that gets no answer is taken for such a redirect: the download resolves afresh rather than retrying the URL |

## Internet Archive

Measured 2026-10-26 between 03:43 and 04:15 IST (from 2026-10-25 22:13 UTC) from the owner's residential connection, with `curl` (the requests below) and the live test in `src/live.test.ts`:

| Fact | Request | Where the manager relies on it |
|---|---|---|
| `https://archive.org/download/<item>/<file>` answers a ranged GET with `302` to a storage host under `archive.org` (here `dn710807.ca.archive.org/0/items/<item>/<file>`), with `Access-Control-Allow-Origin: *` and `Accept-Ranges: bytes` | `GET /download/testmp3testfile/mpthreetest.mp3`, `Range: bytes=0-1023`, `Origin: https://fxmusic.pages.dev` | The browser follows the redirect; `*` allows the redirected request's `Origin: null`, so the bytes stay readable |
| The storage host answers `206` with `Content-Range: bytes 0-1023/198658`, `Content-Length`, `Last-Modified`, `ETag` and `Access-Control-Allow-Origin: *`, and **no `Access-Control-Expose-Headers`** | The same request, after the redirect | A page can read `Content-Length` and `Last-Modified` (CORS-safelisted response headers) but not `Content-Range` or `ETag`. The transfer therefore finds the end of a file from the `416` to the range after its last byte, and compares `Last-Modified` as the validator |
| A range that starts at the end of the file gets `416` from the storage host, with `Content-Range: bytes */198658` and `Access-Control-Allow-Origin: *`, after the same redirect | `GET` with `Range: bytes=198658-264193` | The `416` confirms the end of a file whose `Content-Range` a page can't read |
| The storage host answers a preflight (`OPTIONS` with `Access-Control-Request-Headers: range`) with `405` | `OPTIONS` to the storage host URL | Only requests that need no preflight work: a GET whose only extra header is one single range, which the Fetch standard lists as CORS-safelisted |

The second run of the live test strips the headers a browser hides (it keeps only `Content-Length`, `Content-Type` and `Last-Modified`) and gets the same 198,658 bytes.
