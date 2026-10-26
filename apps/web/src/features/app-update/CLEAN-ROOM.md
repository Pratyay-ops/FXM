# Clean-room log: app updates

Where each fact the Android app's update check relies on comes from, with the date it was checked. GitHub's REST API is documented; the facts below are what the code depends on, checked against its documentation and its live answers. No code was copied from any project.

## GitHub's REST API (checked 2026-10-26)

| Fact | Source |
|---|---|
| `GET https://api.github.com/repos/{owner}/{repo}/releases/latest` answers the most recent published release that is neither a draft nor a pre-release | GitHub REST API docs, "Get the latest release" |
| Before a repository has published a release, it answers `404` with `{"message": "Not Found", "documentation_url": "…#get-the-latest-release", "status": "404"}` | Measured on `Pratyay-ops/FXM`, which had no release yet |
| Without a token, it allows 60 requests an hour per address: `x-ratelimit-limit: 60`, `x-ratelimit-remaining`, and `x-ratelimit-reset` in seconds since the epoch. Past the limit it answers `403` with `x-ratelimit-remaining: 0`, or `429`; its secondary limits send `retry-after` in seconds | Measured response headers; GitHub REST API docs, "Rate limits for the REST API" |
| It answers every origin: `access-control-allow-origin: *`, also on a `404`, and `access-control-expose-headers` includes `ETag`, `Retry-After` and the `X-RateLimit-*` headers, so a page reads them. A GET without custom headers needs no preflight | Measured with `Origin: https://localhost` (the Android app's WebView origin) |
| A release has `tag_name`, `draft`, `prerelease`, `published_at` (ISO 8601) and `assets`; each asset has `name`, `state` (`uploaded` once complete), `size`, `content_type`, `digest` (`sha256:<hex>`) and `browser_download_url`, which is `https://github.com/{owner}/{repo}/releases/download/{tag}/{name}` | Measured on a public repository's latest release |

## The Android app's WebView (Capacitor 8.5.3, read 2026-10-26)

| Fact | Source |
|---|---|
| `BridgeWebViewClient.shouldOverrideUrlLoading` hands every navigation to `Bridge.launchIntent`, which opens a URL whose host isn't the app's own (and isn't in `server.allowNavigation`) with `Intent.ACTION_VIEW`, so in the browser | `node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/BridgeWebViewClient.java`, `Bridge.java` (`launchIntent`) |
| Capacitor never turns on the WebView's support for several windows, so a `target="_blank"` link loads in the same WebView and reaches `shouldOverrideUrlLoading`; Android's `WebSettings.setSupportMultipleWindows` is off by default | `Bridge.java` (WebView settings); Android `WebSettings` reference |
