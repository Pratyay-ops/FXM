# Clean-room log: GitHub's REST API for sync

The protocol facts the sync code (`github.ts`, `engine.ts`, `gist-format.ts`) relies on, each with its source and the date it was read or measured. They come from GitHub's public documentation and from requests to `api.github.com` without a token. No code was copied from other projects. The rules for this log are in [docs/LEGAL.md](../../../../../docs/LEGAL.md).

Measurements were made on 2026-10-25 at about 21:32 UTC (2026-10-26 in India) from a residential connection, with curl, sending `Origin: https://fxmusic.pages.dev`. Docs were read on 2026-10-26, for REST API version `2022-11-28`.

## Endpoints

Source: [REST API endpoints for gists](https://docs.github.com/en/rest/gists/gists?apiVersion=2022-11-28).

| Request | What FXM uses it for | Documented statuses |
|---|---|---|
| `GET /gists?per_page=100&page=n` | Finding the account's sync gist. `per_page` is at most 100; the `Link` header has `rel="next"` while more pages follow | 200, 304, 403 |
| `POST /gists` with `description`, `files` (each `{ content }`) and `public` | Creating the secret sync gist (`public: false`) | 201, 304, 403, 404, 422 |
| `GET /gists/{gist_id}` | Reading the gist | 200, 304, 403, 404 |
| `PATCH /gists/{gist_id}` with `files` | Adding and replacing files (`{ content }`) and deleting them (`null`), as one revision. It returns the updated gist | 200, 404, 422 |
| `DELETE /gists/{gist_id}` | Removing a half-made gist after a failed upload | 204, 304, 403, 404 |
| `GET /user` | Checking a token and getting its login | — |

- **Truncation.** The API returns at most one megabyte of each file's content; a larger file has `truncated: true`, and its whole content is at `raw_url`, or only through `git_pull_url` above ten megabytes. The list of files is cut at 300 files, with a top-level `truncated: true`. FXM keeps every file under 900 KB and the files well under 300, so it never needs `raw_url` (whose host, `gist.githubusercontent.com`, the app's content security policy doesn't allow).
- The [2014 change notice](https://developer.github.com/changes/2014-05-06-gist-api-now-truncating-large-files) applies the truncation to gist objects the API returns. FXM assumes this includes the gist an update returns, so every push downloads the gist (up to 1 MB per file). This is why sync carries 90 days of plays and only the track metadata it uses.
- Don't name files `gistfile` followed by a number (the docs warn against it). FXM's names start with `fxm-`.

## Tokens and permissions

- **Fine-grained tokens.** In [Permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2022-11-28), the account permission **"Gists"** with **write** access covers `POST /gists`, `PATCH /gists/{gist_id}` and `DELETE /gists/{gist_id}` (and the comment, fork and star endpoints). No gist read endpoint is listed, and there is no permission for a single gist: a token with it can change all the account's gists.
- Whether `GET /gists` includes **secret** gists for a fine-grained token isn't documented (searched 2026-10-26). For classic OAuth tokens, a 2015 [GitHub bug bounty write-up](https://bounty.github.com/2015/06/30/gist-api-authz.html) says secret gists are listed only with the `gist` scope. FXM therefore also accepts a pasted gist link.
- **Template URLs.** [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), section "Pre-filling fine-grained personal access token details using URL parameters", and the [changelog of 2025-08-26](https://github.blog/changelog/2025-08-26-template-urls-for-fine-grained-pats-and-updated-permissions-ui): `https://github.com/settings/personal-access-tokens/new` takes `name` (at most 40 characters), `description` (at most 1,024), `target_name` (the owner, the current user by default), `expires_in` (1 to 366 days, or `none`; 30 by default) and one parameter per permission, named after it, whose value is `read`, `write` or `admin`. The account permission `gists` accepts `write` only.
- **Classic tokens** report their scopes in `X-OAuth-Scopes` (exposed to CORS, below). FXM refuses one with any scope besides `gist`.
- The `Authorization: Bearer <token>` form works for both kinds of token ([Authenticating to the REST API](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api?apiVersion=2022-11-28)).

## CORS

[Using CORS and JSONP to make cross-origin requests](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests?apiVersion=2022-11-28): "The REST API supports cross-origin resource sharing (CORS) for AJAX requests from any origin."

Measured (2026-10-25, `OPTIONS /gists/<id>` asking for `PATCH` with `authorization, content-type, if-none-match, x-github-api-version`):

- `204`, `Access-Control-Allow-Origin: *`, `Access-Control-Max-Age: 86400`.
- `Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE`.
- `Access-Control-Allow-Headers` includes `Authorization`, `Content-Type`, `If-Match`, `If-Modified-Since`, `If-None-Match`, `If-Unmodified-Since`, `X-GitHub-Api-Version` and `X-Requested-With`.
- `Access-Control-Expose-Headers` includes `ETag`, `Link`, `Location`, `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Used`, `X-RateLimit-Resource`, `X-RateLimit-Reset`, `X-OAuth-Scopes` and `X-Accepted-OAuth-Scopes`.
- No `Access-Control-Allow-Credentials`: with `Access-Control-Allow-Origin: *`, a request that sends credentials would fail, so FXM sends none (`credentials: 'omit'`).

## Responses

Measured (2026-10-25):

- An error body is JSON: `{"message": "Not Found", "documentation_url": "https://docs.github.com/rest/gists/gists#get-a-gist", "status": "404"}` for an unknown gist.
- `GET /gists/<id>` of a public gist: the top-level fields include `id`, `html_url`, `description`, `public`, `owner` (with `login`), `files`, `history` (entries with `version`, `committed_at`, `change_status`, `url`, `user`), `truncated` and `updated_at`. Each file has `filename`, `type`, `language`, `raw_url`, `size`, `truncated`, `content` and `encoding`.
- It came with a weak `ETag` (`W/"…"`), `Last-Modified`, and `Cache-Control: public, max-age=60, s-maxage=60`. FXM reads with `cache: 'no-store'` and sends `If-None-Match` itself, so it gets GitHub's 304 rather than the browser's cache.

## Rate limits and pacing

- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28): 5,000 requests an hour with a personal access token. Secondary limits: at most 100 concurrent requests, 80 content-generating requests a minute and 500 an hour. After a limit, wait for `retry-after` seconds; without it, until `x-ratelimit-reset` when `x-ratelimit-remaining` is `0`; without either, at least a minute, then back off exponentially. GitHub answers a limit with 403 or 429.
- [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28):
  - A conditional request (`if-none-match` with an `etag`) answered with 304 "does not count against your primary rate limit" when it carries a valid `Authorization` header.
  - "Conditional requests for unsafe methods, such as `POST`, `PUT`, `PATCH`, and `DELETE` are not supported" unless an endpoint says otherwise. The gist endpoints don't, so FXM checks with a conditional read right before a push, and relies on revision lineage for what that can't catch.
  - Make requests serially, and wait at least a second between many `POST`, `PATCH`, `PUT` or `DELETE` requests. FXM syncs one request at a time and spaces the requests of a large upload a second apart.

## Not yet known

- Whether `PATCH /gists/{gist_id}` refuses (422) or ignores the deletion of a file the gist doesn't hold. FXM handles both: a refused upload makes the sync read the gist and merge again.
- Whether GitHub limits the size of a request body to the gist endpoints. FXM sends at most 4 MB per request.
