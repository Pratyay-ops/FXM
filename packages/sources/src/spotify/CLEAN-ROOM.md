# Spotify clean-room log

The Spotify provider's clean-room log is the [Clean-room log](README.md#clean-room-log) section of this folder's README, next to the description of how the provider works. For every protocol fact the provider relies on, it records where the fact came from and when: each persisted-query hash with the Spotify web-player file it was found in, the variables and response field paths, the token flow and key derivation, and the fixtures.

Before code relies on a new fact, add it there with its source and date, as the [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) requires.

## Entries since the provider was written

| Date | Stage | What | Where it is recorded |
|---|---|---|---|
| 2026-10-26 | 3.5 | The logged-in calls (`fetchLibraryTracks`, `libraryV3`, `fetchPlaylist` with the account, `profileAttributes`) rechecked in Spotify's own `web-player.f954508a.js`: their variables, the `features` enum of `libraryV3`, the library and profile response readers, and the playlists' `revisionId`. No logged-in session yet | [The logged-in calls, rechecked for stage 3.5](README.md#variables-and-field-paths) |
| 2026-10-26 | 7.4 | The desktop app's login window. Spotify's login page, `https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F`, answered `307` to its localized form `/en/login?continue=…` (one request without cookies, 2026-10-26 06:30 UTC). The login cookie is `sp_dc` for `spotify.com`, as the research memo of 2026-10-25 names it (section 3.2); its other attributes weren't observed, as FXM has no account, so the app accepts it from `spotify.com` and any host under it. The token call that sends it (`Cookie: sp_dc=…`) is the logged-in one of stage 3.5 (`reason=transport`), whose answer's fields 1.5 recorded (`accessToken`, `accessTokenExpirationTimestampMs`, `isAnonymous`, and `totpVerExpired` with a 400). No login was made, and no cookie or token was recorded | This row, and [the desktop app's README](../../../../apps/desktop/README.md#spotify-login) |
