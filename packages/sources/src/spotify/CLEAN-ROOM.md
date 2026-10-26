# Spotify clean-room log

The Spotify provider's clean-room log is the [Clean-room log](README.md#clean-room-log) section of this folder's README, next to the description of how the provider works. For every protocol fact the provider relies on, it records where the fact came from and when: each persisted-query hash with the Spotify web-player file it was found in, the variables and response field paths, the token flow and key derivation, and the fixtures.

Before code relies on a new fact, add it there with its source and date, as the [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) requires.

## Entries since the provider was written

| Date | Stage | What | Where it is recorded |
|---|---|---|---|
| 2026-10-26 | 3.5 | The logged-in calls (`fetchLibraryTracks`, `libraryV3`, `fetchPlaylist` with the account, `profileAttributes`) rechecked in Spotify's own `web-player.f954508a.js`: their variables, the `features` enum of `libraryV3`, the library and profile response readers, and the playlists' `revisionId`. No logged-in session yet | [The logged-in calls, rechecked for stage 3.5](README.md#variables-and-field-paths) |
| 2026-10-26 | 6.5 | The Android login: Spotify's login page and where it redirects, what its content security policy lets it load, the `sp_dc` login cookie it sets for the token endpoint, and the password reset that lets an account made with Google sign in with its email address | [`apps/mobile/android/fxm-spotify/CLEAN-ROOM.md`](../../../../apps/mobile/android/fxm-spotify/CLEAN-ROOM.md) |
