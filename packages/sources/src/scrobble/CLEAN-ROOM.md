# Scrobbling clean-room log

Every protocol fact FXM's scrobbling code relies on, with its source and the date it was seen, as the [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) requires. Both write APIs are documented by the services themselves; add a fact here before code relies on it.

The documentation was read on 2026-10-26. The live checks ran from one residential connection in India on 2026-10-26 (IST; the evening of 2026-10-25 UTC), with the FXM web app's address (`https://fxmusic.pages.dev`) as `Origin` and made-up credentials only: FXM has no Last.fm API account and no ListenBrainz token, so no successful answer was recorded. `live.test.ts` repeats the checks (five requests).

Bloomee, which the research memo cites for "the user supplies the Last.fm shared secret", was not opened for this work: that idea is the services' own design (Last.fm signs calls with each API account's secret).

## Last.fm (`ws.audioscrobbler.com/2.0/`)

### Scrobbling rules

| Fact | Source | Date |
|---|---|---|
| For every track the client should send a `track.updateNowPlaying` request and a `track.scrobble` request. Now playing is "optional for scrobbling clients, but recommended", should be sent "as soon as a user starts listening to a track", doesn't affect charts, and "Now Playing requests that fail should not be retried" | Scrobbling 2.0 documentation, <https://www.last.fm/api/scrobbling> | 2026-10-26 |
| "A track should only be scrobbled when the following conditions have been met: The track must be longer than 30 seconds. And the track has been played for at least half its duration, or for 4 minutes (whichever occurs earlier.)" A scrobble may then be sent at any time; "It is often most convenient to send a scrobble request when a track has finished playing" | The same page | 2026-10-26 |
| Don't take metadata from file names, "only use meta data from well-structured sources such as ID3 tags", and don't scrobble the corrections now playing returns unless the user approved them | The same page | 2026-10-26 |
| `chosenByUser` should be `0` ("false") when the music "is effectively chosen by someone other than themselves (e.g. from a Last.fm radio stream; from some other recommendation service ...)"; "If there is any ambiguity or doubt then don't send this value" | The same page | 2026-10-26 |
| Write calls are HTTP `POST`s to `http://ws.audioscrobbler.com/2.0/` "with form urlencoded parameters in the body", UTF-8, and must be authenticated. "A batch request may contain up to 50 scrobbles" | The same page | 2026-10-26 |
| Clients should keep scrobbles that need a retry in a local cache that survives restarts, and send them in order, "cached scrobbles ... before new scrobbles", in batches of up to 50 | The same page, "Retrying cached scrobbles" | 2026-10-26 |
| Inspect the body whatever the HTTP status: "a HTTP status of 200 OK does not mean the request was successful". Retry on error 11 (service offline) and 16 (temporarily unavailable); on 9 (invalid session key) re-authenticate first; "All other error codes indicate the scrobble request was incorrectly formed in some way and should not be retried" | The same page, "Error handling" | 2026-10-26 |
| Filtered scrobbles are not errors: the status stays `ok` and each scrobble of a batch is filtered on its own, with ignored codes 0 (passed), 1 (artist), 2 (track), 3 (timestamp too old), 4 (too new), 5 (daily limit), "We may add additional ignored codes in the future" | The same page, "Filtered Requests"; the `track.scrobble` page | 2026-10-26 |

### Methods

| Fact | Source | Date |
|---|---|---|
| `track.scrobble` takes, per scrobble in array notation `[i]` (0 ≤ i ≤ 49): `artist`, `track`, `timestamp` ("The time the track started playing, in UNIX timestamp format ... UTC") required; `album`, `context`, `streamId`, `chosenByUser` (`1` or `0`, "Assumes 1 if not specified"), `trackNumber`, `mbid`, `albumArtist`, `duration` (seconds) optional; plus `api_key`, `api_sig` and `sk`. Parameter names are case sensitive. "the parameter names MUST be sorted according to the ASCII table (i.e., artist[10] comes before artist[1])" for the signature. Sample answer: `<scrobbles accepted="1" ignored="0"><scrobble>… <ignoredMessage code="0"></ignoredMessage></scrobble></scrobbles>` | <https://www.last.fm/api/show/track.scrobble> | 2026-10-26 |
| `track.updateNowPlaying` takes `artist`, `track` (required), `album`, `trackNumber`, `context`, `mbid`, `duration` (seconds), `albumArtist`, plus `api_key`, `api_sig`, `sk`; a write service, `POST` only, "including the 'method' parameter" in the body | <https://www.last.fm/api/show/track.updateNowPlaying> | 2026-10-26 |
| Errors listed for both: 2 invalid service, 3 invalid method, 4 authentication failed, 5 invalid format, 6 invalid parameters, 7 invalid resource, 8 operation failed, 9 invalid session key, 10 invalid API key, 11 service offline, 13 invalid method signature, 16 temporary error, 26 suspended API key, 29 rate limit exceeded | The two method pages | 2026-10-26 |

### Authentication

| Fact | Source | Date |
|---|---|---|
| Desktop flow: (1) an API account gives an API key and a shared secret; (2) `auth.getToken` with `api_key` and `api_sig` returns a token, not yet authorized; (3) send the user to `http://www.last.fm/api/auth/?api_key=…&token=…` in a browser; after granting access "the user is asked to close their browser and return to your application"; (4) `auth.getSession` with `api_key`, `token` and `api_sig` returns the session. "You can only use an authentication token once" | Desktop application how-to, <https://www.last.fm/api/desktopauth>; authentication spec, <https://www.last.fm/api/authspec> | 2026-10-26 |
| Tokens "are valid for 60 minutes from the moment they are granted"; session keys "have an infinite lifetime by default", and users can revoke them in their Last.fm settings | The same pages | 2026-10-26 |
| The web flow instead redirects to the account's callback URL, or to one given as `cb`, with `?token=` appended. FXM doesn't use it: the token would reach FXM's host in a URL | Web application how-to, <https://www.last.fm/api/webauth> (read through a fetcher; the page answers plain HTTP clients with 406) | 2026-10-26 |
| The mobile flow (`auth.getMobileSession`) sends the user's password. FXM doesn't use it: FXM never handles passwords | <https://www.last.fm/api/authspec>, section 5 | 2026-10-26 |
| `auth.getSession` answers `<session><name>MyLastFMUsername</name><key>d580d57f…</key><subscriber>0</subscriber></session>`, and fails with 4 (invalid token), 14 ("This token has not been authorized"), 15 ("This token has expired") among the general errors. `auth.getToken` answers `<token>cf45fe5a…</token>`; its JSON form is `format=json` | <https://www.last.fm/api/show/auth.getSession>, <https://www.last.fm/api/show/auth.getToken> | 2026-10-26 |
| Signing: order every parameter by name and concatenate them as `<name><value>`, leaving out `format` and `callback`, UTF-8; append the secret; take the 32-character hexadecimal MD5. Example: secret `ilovecher`, `md5("api_keyxxxxxxxxxxmethodauth.getSessiontokenyyyyyyilovecher")` | <https://www.last.fm/api/authspec>, section 8 | 2026-10-26 |
| MD5 itself, with its padding, step constants and test suite | RFC 1321, <https://www.rfc-editor.org/rfc/rfc1321> | 2026-10-26 |

### Observed

| Fact | Source | Date |
|---|---|---|
| A `POST` of `method=auth.getToken` with a made-up `api_key` and `format=json` answers `HTTP 403` with `{"message":"Invalid API key - You must be granted a valid key by last.fm","error":10}`, and `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, GET, OPTIONS`, `Access-Control-Max-Age: 86400`. So the method is recognized over `POST`, errors come as JSON with `error` and `message`, and any web page can read the answer | Own request; `fixtures/lastfm-error-invalid-api-key.json`; `live.test.ts` | 2026-10-26 |
| The preflight for that address allows only `content-type` as a request header. FXM's form-encoded `POST`s need no preflight at all | Own request (`OPTIONS`) | 2026-10-26 |
| **Not recorded:** the JSON form of the successful answers of `auth.getToken`, `auth.getSession`, `track.updateNowPlaying` and `track.scrobble`. The `.synthetic` fixtures turn the documented XML samples into the JSON shape Last.fm's other methods use (attributes under `@attr`, text under `#text`, a list of one possibly as the object itself), and the parser accepts counts as numbers or strings. An answer without an `error` that FXM can't read counts a batch as accepted, so it is never sent twice | — | 2026-10-26 |

## ListenBrainz (`api.listenbrainz.org`)

| Fact | Source | Date |
|---|---|---|
| `POST /1/submit-listens` takes the user token in the `Authorization` header as `Token <user token>`, with `Content-Type: application/json`; status 200 (accepted), 400 (invalid JSON, "see error message"), 401 (invalid authorization) | Core API documentation, <https://listenbrainz.readthedocs.io/en/latest/users/api/core.html> | 2026-10-26 |
| "Listens should be submitted for tracks when the user has listened to half the track or 4 minutes of the track, whichever is lower. If the user hasn't listened to 4 minutes or half the track, it doesn't fully count as a listen and should not be submitted." No minimum length is given | The same page | 2026-10-26 |
| `GET /1/validate-token` with the same `Authorization` header answers `{"code": 200, "message": "Token valid.", "valid": true, "user_name": "…"}` or `{"code": 200, "message": "Token invalid.", "valid": false}`; 400 when no token was sent. It also reads a `token` query parameter "for backward compatibility", which FXM never uses | The same page | 2026-10-26 |
| Constants: `MAX_LISTENS_PER_REQUEST` 1000, `MAX_LISTEN_SIZE` 10,240 bytes, `MAX_LISTEN_PAYLOAD_SIZE` 10,240,000 bytes, `MAX_DURATION_MS_LIMIT` 2,073,600,000 (24 days), `MAX_TAGS_PER_LISTEN` 50, `LISTEN_MINIMUM_TS` 1033430400 (the earliest `listened_at`). All timestamps are UTC Unix seconds | The same page, "Constants" | 2026-10-26 |
| Listen types: `single` ("user just finished listening to track", exactly one listen), `playing_now` ("user just began listening", exactly one, `listened_at` omitted, "only stored temporarily"), `import` ("previously saved listens", one or more). Each listen has `listened_at` (the playback start, an integer) and `track_metadata` with `artist_name` and `track_name` (simple strings, required), optional `release_name`, and `additional_info` | JSON documentation, <https://listenbrainz.readthedocs.io/en/latest/users/json.html> | 2026-10-26 |
| `additional_info` fields FXM fills: `media_player` and `submission_client` (names without versions), `media_player_version`, `submission_client_version`, `duration_ms` (integer; "only include one of `duration_ms` or `duration`"), `duration_played` (seconds heard), `tracknumber` (typed as a string), `isrc`, `spotify_id` ("The Spotify track URL", e.g. `http://open.spotify.com/track/1rrgWMXGCGHru5bIRxGFV0`). Keys without data are left out. FXM doesn't send `music_service` or `origin_url`, which would publish where FXM got the audio | The same page | 2026-10-26 |
| "All users of the API must ensure that each of their client applications never make more than ONE call per second." Every answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset-In` (seconds; recommended) and `X-RateLimit-Reset`; over the limit, `429 Too Many Requests` | API index, "Rate limiting", <https://listenbrainz.readthedocs.io/en/latest/users/api/index.html> | 2026-10-26 |
| ListenBrainz asks for a `User-Agent` of the form `Application name/<version> (contact)`. Browsers don't let pages set it reliably, and the preflight below doesn't allow it, so the web app never sets one; submissions name FXM in `additional_info` instead | The same page, "User-agent"; the preflight below | 2026-10-26 |

### Observed

| Fact | Source | Date |
|---|---|---|
| The preflights of `/1/submit-listens` (`POST`) and `/1/validate-token` (`GET`) answer 200 with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Authorization, Content-Type` and `Access-Control-Max-Age: 21600` | Own requests (`OPTIONS`); `live.test.ts` | 2026-10-26 |
| `GET /1/validate-token` without a token: `400 {"code":400,"error":"You need to provide an Authorization token."}`. With a made-up token: `200 {"code":200,"message":"Token invalid.","valid":false}` | Own requests; `fixtures/listenbrainz-validate-*.json`; `live.test.ts` | 2026-10-26 |
| `POST /1/submit-listens` with a made-up token: `401 {"code":401,"error":"Invalid authorization token."}` | Own request; `fixtures/listenbrainz-submit-invalid-token.json` | 2026-10-26 |
| Answers carry `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: X-RateLimit-Remaining,X-RateLimit-Limit,X-RateLimit-Reset,X-RateLimit-Reset-In`, so a page can read the limits; the limit was 30 requests per window of about 10 seconds | Own requests | 2026-10-26 |
| **Not recorded:** the body of a successful submission (FXM has no token). FXM reads only the status | — | 2026-10-26 |
