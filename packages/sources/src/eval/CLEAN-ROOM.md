# Matching evaluation: clean-room log

The [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) asks that every protocol fact FXM's code relies on be recorded with its source and date, in the log of the service it is about. The recorder in this folder talks to no service of its own: it calls the Spotify, MusicBrainz and YouTube Music providers of stages 1.5, 1.6 and 1.3. The facts the evaluation relies on are in their logs:

- [Spotify](../spotify/README.md#clean-room-log): the chart and editorial playlists anonymous tokens can read, Spotify's naming of its own recordings ("Spotify Singles"), what `metadata/4` answers for chart tracks, and the one artist per stream of the "Download your data" export;
- [YouTube](../youtube/CLEAN-ROOM.md) (source **Eval-25**): what a songs search for an ISRC lists, and the lines YouTube generates for a label upload's description;
- MusicBrainz's public API documentation, in [its README](../musicbrainz/README.md).

This log holds what is left: facts about catalogues FXM has no provider for, which the evaluation takes from research.

**Nothing here came from a GPL, AGPL or unlicensed project.** The recorder, the label rules and the report were written from these facts and FXM's own code.

## Sources

| Key | Source |
|---|---|
| **Research** | FXM's research memo of 2026-10-25 ([`docs/research/2026-10-25-userside-memo.md`](../../../../docs/research/2026-10-25-userside-memo.md)) and the matching golden set built from it |

## Facts

| Fact | Source | Date |
|---|---|---|
| ISRC squatters: Deezer maps GBAYE0601696 to "Live-LongLive-Strong" by Waw\*Mart and QMFMF2447070 to "You and me" by Lil dexxy, while YouTube Music returns other recordings for them | Research (matching golden set, `squatter/…`) | 2026-10-25 |
