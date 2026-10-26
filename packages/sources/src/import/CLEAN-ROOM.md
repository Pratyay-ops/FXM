# Imports clean-room log

The import code reads files other programs write and links other sites show: Spotify's "Download your data" export, Exportify's CSV files, M3U playlists, and YouTube and YouTube Music links. It calls no service itself: Spotify playlists go through the Spotify provider (its facts are in [`../spotify/README.md`](../spotify/README.md#clean-room-log)), YouTube playlists and searches through the YouTube adapter (stage 1.3 logs those facts in `../youtube/CLEAN-ROOM.md`), and MusicBrainz lookups through the MusicBrainz client.

Each fact below says where it came from and when it was checked, as the [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) asks. No code, fixtures or translated logic were taken from any other project; the test files are constructed by hand in the shapes below.

## Spotify's data export

Checked 2026-10-26.

- **Where it is asked for.** Spotify's support page "Data rights and privacy settings" (support.spotify.com, `article/data-rights-and-privacy-settings`, read 2026-10-26) says a ZIP file with a copy of one's personal data comes from the automated "Download your data" tool on the Account Privacy page, `https://www.spotify.com/account/privacy/`, which the Import page links to.
- **What the export holds, and when it ends.** Spotify's "Understanding my data" page (support.spotify.com, `article/understanding-my-data`, read 2026-10-26) describes the account data's playlists (name, last modified date, description, followers, and per song the track, artist and album names, and local tracks), the library (songs, episodes, shows, artists and albums, with names, creators and URIs) and a year of streaming history whose time is "Date and time of when the stream ended in Coordinated Universal Time format (UTC)", and the extended streaming history "for the lifetime of your account", with the stream end time, milliseconds played, track, artist, album and track URI, start and end reasons, shuffle and skips. It describes the fields in prose only; the exact JSON keys are in a "Read Me First" file inside the download.
- **Extended streaming history keys.** The README of `Wallerand/spotify-unwrapped` on GitHub (read 2026-10-26; a field table for loading the files into a database, no code taken) lists `ts` ("a timestamp indicating when the track stopped playing in UTC"), `username`, `platform`, `ms_played`, `conn_country`, `ip_addr_decrypted`, `user_agent_decrypted`, `master_metadata_track_name`, `master_metadata_album_artist_name`, `master_metadata_album_album_name`, `spotify_track_uri` (`spotify:track:…`), `episode_name`, `episode_show_name`, `spotify_episode_uri`, `reason_start`, `reason_end` (e.g. `trackdone`, `endplay`, `fwdbtn`, `logout`), `shuffle`, `skipped`, `offline`, `offline_timestamp` and `incognito_mode`, in files named `Streaming_History_Audio_*.json`. The same README names `Playlist*.json` and `YourLibrary.json`, and lists each playlist's `name`, `lastModifiedDate` (a date without a time), `description`, `numberOfFollowers` and `items`.
- **The account data's history keys.** `endTime`, `artistName`, `trackName` and `msPlayed`, as in Spotify Community posts and the r-bloggers tutorial "Exploring My Spotify Listening" (2020) found by a web search on 2026-10-26; `endTime` is written `YYYY-MM-DD HH:mm`. Files are `StreamingHistory0.json` in older exports and `StreamingHistory_music_0.json` (with `StreamingHistory_podcast_0.json` beside it, holding `podcastName` and `episodeName`) in newer ones.
- **Not confirmed from a primary source:** the keys inside a playlist item (`track` with `trackName`, `artistName`, `albumName`, `trackUri`; `episode`; `localTrack`; `audiobook`; `addedDate`) and inside the library's lists (`tracks` with `artist`, `album`, `track`, `uri`; `albums` with `artist`, `album`, `uri`; `artists` with `name`, `uri`). They follow the export as the community describes it, but no page FXM could cite shows them. The parser reads only these keys and counts anything else as unreadable, so a different shape imports nothing wrong. **To confirm:** the owner's own export (stage 1.12 uses one), checked against the parser before the stage ships to users.
- **What FXM reads.** Only the files above, and in them only the keys above. The export's other files (user data, search queries, payments, inferences and more) are never parsed, and the history's personal keys (`username`, `platform`, `conn_country`, `ip_addr_decrypted`, `user_agent_decrypted`) are never copied; a test checks that their values never reach the parsed import.

## Exportify's CSV files

Checked 2026-10-26 in `watsonbox/exportify` on GitHub (MIT licence), through jsDelivr (`cdn.jsdelivr.net/gh/watsonbox/exportify@master/…`):

- **Column names**, from `src/i18n/locales/en/translation.json`: "Track URI", "Track Name", "Artist URI(s)", "Artist Name(s)", "Album URI", "Album Name", "Album Artist URI(s)", "Album Artist Name(s)", "Album Release Date", "Album Image URL", "Disc Number", "Track Number", "Track Duration (ms)", "Track Preview URL", "Explicit", "Popularity", "ISRC", "Is Playable", "Added By" and "Added At"; with album data, "Album Genres", "Label" and "Copyrights"; with artist data, "Artist Genres"; and the audio features.
- **Cell values**, from `src/components/data/TracksBaseData.ts`: several artists are joined by `", "`, with a comma inside a name escaped as `\,`; the duration is Spotify's milliseconds as is; the ISRC is the track's `external_ids.isrc` or empty; the release date is Spotify's own (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`).
- The README of the same repository lists the same columns (spelling one "Explicit?", which the parser accepts too), and the saved-albums file's columns.

Other exporters' column names that the parser also accepts ("Title", "Artist", "Album", "Duration", "Playlist name", "Spotify - id" and the like) are common words, not facts of any one program.

## M3U and M3U8

M3U is a de facto format with no single specification; FXM reads the conventions every player writes, checked against FXM's own constructed samples on 2026-10-26:

- `#EXTM3U` first; `#EXTINF:<seconds>,<display title>` before an entry, with `-1` for an unknown length and optional `key="value"` attributes before the comma; the display title is usually "Artist - Title";
- `#PLAYLIST:<name>`, `#EXTALB:<album>` and `#EXTART:<artist>`;
- other lines starting with `#` are comments; every other line is an entry: a path (relative, absolute, Windows or a `file:` URL) or a URL;
- `.m3u8` files are UTF-8; plain `.m3u` files are often in the system's legacy encoding (Windows-1252 on Western Windows systems), so text that is not valid UTF-8 is read as Windows-1252.

## YouTube and YouTube Music links

Public URL forms, recorded on 2026-10-26:

- **A playlist:** `https://www.youtube.com/playlist?list=<id>`. YouTube's help page "Share playlists" (support.google.com/youtube/answer/57793) says sharing creates a link to give to others; guides show the link in this form (e.g. windowsdigitals.com's "How to Share and Collaborate a Playlist on YouTube with Friends"), and `watch?v=<video>&list=<playlist>` for a video playing inside a playlist. music.youtube.com uses the same path and parameter.
- **A playlist's browse ID** is its ID with a `VL` prefix, which FXM's IDs leave out (`@fxm/core`'s ID rules, stage 1.1).
- **A video:** `watch?v=<11-character id>` on both sites, and `youtu.be/<id>`, `/shorts/<id>`, `/embed/<id>` and `/live/<id>` on youtube.com, the forms the sites themselves link to; a videoId is 11 characters of the URL-safe base64 alphabet (`@fxm/core`'s ID rules).
- **Lists FXM refuses:** `LL` (liked videos), `WL` (Watch later), `LM` (YouTube Music's liked songs) and `RD…` mixes, except YouTube Music's curated playlists whose IDs start with `RDCLAK`. This is FXM's reading of the IDs YouTube gives its personal and automatic lists, not checked against a primary source; refusing such a link costs nothing, since no anonymous request can read those lists.

Spotify links and URIs are read with the Spotify provider's own `parseSpotifyLink` (see its log).
