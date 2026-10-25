# Matching evaluation: clean-room log

The [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) asks that every protocol fact FXM's code relies on be recorded with its source and date. The recorder in this folder talks to no service of its own: it calls the Spotify, MusicBrainz and YouTube Music providers of stages 1.5, 1.6 and 1.3, whose logs hold the protocol facts they rely on ([Spotify](../spotify/CLEAN-ROOM.md), [YouTube](../youtube/CLEAN-ROOM.md), and MusicBrainz's public API documentation in [its README](../musicbrainz/README.md)). This log holds what the evaluation itself relies on.

**Nothing here came from a GPL, AGPL or unlicensed project.** The recorder, the label rules and the report were written from the facts below and FXM's own code.

## Sources

| Key | Source |
|---|---|
| **Proof** | FXM's own requests, through the providers, during the recorder's proof run from a residential connection on 2026-10-25 (UTC): the answers, reduced to what the labelled set keeps, are the groups in `packages/core/src/matching/eval/fixtures/groups/` |
| **Spotify** | Spotify's public web pages for the playlists named, `open.spotify.com/playlist/<id>`, as the web player links them |
| **Research** | FXM's research memo of 2026-10-25 ([`docs/research/2026-10-25-userside-memo.md`](../../../../docs/research/2026-10-25-userside-memo.md)) and the matching golden set built from it |

## Facts

| Fact | Source | Date |
|---|---|---|
| Spotify's chart and editorial playlists are public playlists with base62 IDs (`37i9dQZEVXb…` for the Top 50 charts, `37i9dQZF1D…` for editorial ones) that anonymous web-player tokens can read with `fetchPlaylist`; Top 50 Global, Japan and India and Classical Essentials answered with 50 tracks each | Spotify; Proof | 2026-10-25 |
| Spotify names its own recordings "<title> - Spotify Singles", on a single of the same name; a track search for "Spotify Singles" finds them | Proof (search "Spotify Singles", first hit "Challa - Spotify Singles") | 2026-10-25 |
| `metadata/4` answers the ISRC, label, release date, album type and popularity of chart tracks anonymously | Proof (8 of 8 tracks) | 2026-10-25 |
| A YouTube Music songs search for an ISRC lists the recording first when YouTube Music has it, and filler when it does not; the top-result card of the unfiltered search can be the recording too | Proof (the recording first for 6 of 8 ISRCs, filler for the other 2; the card for Vaundy's "しわあわせ"); Research §6.3 | 2026-10-25 |
| The lines YouTube generates for a label upload's description: "Provided to YouTube by <distributor>", "<title> · <artists>", the album, "℗ <year> <label>", "Released on: <date>", then credits | Proof (descriptions of `fsM-eXNNSSo`, `Xay0HJ4LsNc`, `ChdQ3xmTh8s`); `parseReleaseDescription` in `@fxm/core` | 2026-10-25 |
| ISRC squatters: Deezer maps GBAYE0601696 to "Live-LongLive-Strong" by Waw\*Mart and QMFMF2447070 to "You and me" by Lil dexxy, while YouTube Music returns other recordings for them | Research (matching golden set, `squatter/…`) | 2026-10-25 |
