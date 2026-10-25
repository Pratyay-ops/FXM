# Spotify provider

Stage 1.5 builds FXM's built-in Spotify provider in this folder: metadata, radio and the home feed from Spotify's own web-player APIs, read on the user's device. It is a clean-room implementation, so before any provider code was written, each persisted-query hash it will use was sourced from Spotify's own web-player files. This log records where and when. The hashes live in the versioned `spotify-config.json`, next to the endpoints, the default secret-source URLs (URLs only, never a secret) and the browser User-Agent for native transports.

## Clean-room log

The provider is written from protocol facts only: endpoints, operation names, persisted-query hashes, variables and field paths, recorded from Spotify's own web player and from FXM's own requests. **Nobody opens the AGPL plugin `sonic-liberation/spotube-plugin-spotify`, or any GPL project, while writing it, and no code or fixtures are copied from anywhere.**

### Persisted-query hashes

Each hash was found as a persisted-query definition, `("<operation>","query","<sha256Hash>")`, in Spotify's own web-player JavaScript, fetched from `https://open.spotifycdn.com/cdn/build/web-player/` on **2026-10-25 at 18:09 UTC**. The main bundle was named in `https://open.spotify.com/`, and the route chunks in the bundle's webpack chunk map. Each hash was then confirmed by a successful anonymous call the same day, except where noted.

| Operation | sha256Hash | Found in | Confirmed live |
|---|---|---|---|
| `searchDesktop` | `eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03` | `xpui-routes-search.2aa27db9.js` | Yes |
| `searchTracks` | `b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751` | `xpui-routes-search.2aa27db9.js` | Yes |
| `searchAlbums` | `202cb3305e31e5a0767ba7925f28bd728cf8f8b0217e6da43909056071cd70e9` | `xpui-routes-search.2aa27db9.js` | Yes |
| `searchArtists` | `7bf95d754fdbe32c8b161fbbe54d1ae50974900df4dce4c8f1afcbcad153224d` | `xpui-routes-search.2aa27db9.js` | Yes |
| `searchPlaylists` | `d520014e748f9ea44f7707d8df1819867ac1205e8b7f3e28f22fe5fc858921b1` | `xpui-routes-search.2aa27db9.js` | Yes |
| `getTrack` | `fe16b8083eec2305854db612ca75589bcb71e009dc7a4d014f29bd534a4c01f5` | `web-player.f954508a.js` | Yes |
| `getAlbum` | `0b6ce3511e1b02e4a40fa95440f992acbe85080eb308af9194322d708fc1914f` | `web-player.f954508a.js` | Yes |
| `queryArtistOverview` | `9f8134ef565e78621f1e1793555bd6633c5ac144ae0f89604ed3ae3f80b3c8e6` | `web-player.f954508a.js` | Yes |
| `queryArtistRelated` | `3d031d6cb22a2aa7c8d203d49b49df731f58b1e2799cc38d9876d58771aa66f3` | `xpui-routes-artist.2459ba1a.js` | Yes |
| `fetchPlaylist` | `21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf` | `web-player.f954508a.js` | Yes |
| `home` | `5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1` | `web-player.f954508a.js` | Yes (anonymous) |
| `homeSection` | `5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1` (one document holds `home`, `homeSection` and `homePinnedSections`) | `web-player.f954508a.js` | Yes (anonymous) |
| `libraryV3` | `390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455` | `web-player.f954508a.js` | No: needs a login |
| `fetchLibraryTracks` | `087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240` | `web-player.f954508a.js` | No: needs a login |
| `profileAttributes` | `08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0` | `web-player.f954508a.js` | No: needs a login |
