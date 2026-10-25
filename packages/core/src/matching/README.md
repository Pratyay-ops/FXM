# Matching engine

`@fxm/core`'s matching engine finds the YouTube Music song for a track from another catalog (a Spotify track, an import row, a MusicBrainz recording), and the song for an official music video in Music mode. It implements [ARCHITECTURE.md §12](../../../../docs/ARCHITECTURE.md#12-matching-engine-packagescoresrcmatching) as corrected by the research memo of 2026-10-25 (sections 6 and 11.7).

The engine is pure: no network, no clock, no storage. A provider fetches the pages the planner asks for and hands them over; the engine ranks the candidates and decides. Everything here is exported from `@fxm/core`.

## Using it from a provider

```ts
import { addMatchResponse, matchTrack, nextMatchRequest, type MatchPages } from '@fxm/core'

let pages: MatchPages = {}
for (let request = nextMatchRequest(track, pages, options); request; request = nextMatchRequest(track, pages, options)) {
  pages = addMatchResponse(pages, await fetchFor(request)) // one InnerTube call each, from the request budget
}
const result = matchTrack(track, pages, { auto: settings.autoMatch, mode: ctx.mode })
```

`track` is any `MatchSource`. A core `Track` is one; imports and providers add what a track lacks: `label`, `albumType` and `isrcOrigin` (`catalog`, `musicbrainz-exact` or `musicbrainz-fuzzy`). The pages are lists of core `Track`s in page order, as the YouTube provider returns them: `kind` from `musicVideoType`, the album with its browse ID, the duration, and `explicit: false` for songs without the explicit badge (leaving it out turns the explicit check off for that item).

| Request (`nextMatchRequest`) | What the provider fetches | Files it as (`addMatchResponse`) |
|---|---|---|
| `isrc-songs` | YouTube Music songs search with the ISRC as the query (`attempt` 2 is the retry) | `isrcSongs[attempt - 1]` |
| `isrc-top-card` | Unfiltered search for the ISRC; only the top-result card | `isrcTopCard` (`null` when there is none) |
| `text-songs` | Songs search for "all artists + title" (`textSearchQuery`) | `text` |
| `album-songs` | The same with the album (`albumSearchQuery`) | `album` |
| `release-facts` | The descriptions of the listed candidates, read with `parseReleaseDescription` | `releaseFacts`, keyed by track ID |
| `videos`, `youtube` | Music + Video mode only: the videos filter, then regular YouTube ("artists - title") | `videos`, `youtube` |

The plan costs one call when the ISRC passes at once, and about seven at most: the ISRC search, the top-result card, the retry, the text search, the album search and two descriptions. A fuzzy ISRC gets the first search only. Release facts are fetched once, for the top two songs, and only when the source has a label or a release date.

Official videos in Music mode go through `matchVideoToSong(video, songs, options)`, where `songs` is the songs search for the video's artists and title. A song link on the video (`Track.songId`, from YouTube Music's album pages) wins without scoring.

## What the engine decides

`matchTrack` returns a `MatchResult`:

- `band`: `auto` (plays without asking), `suggest` (plays only after an explicit user action, with "Not the right version?"; queues skip it and mark it "needs review", imports send it to the review list) or `none` (shows the alternatives and a manual search).
- `best` and `candidates`: core `AudioCandidate`s, best first, each with `confidence` (the score), `evidence` (text for people) and `signals` (`isrcVerified`, `releaseId`, `releaseYear`, `label`, `sourceAlbumMatch`). Stage 2.6's match cache stores the band, the evidence and the signals.
- `isrc`: the gate's verdict (`verified`, `miss`, `hint`, `hint-miss`, `not-run`, `no-isrc`) with every rejected item and why.
- `autoBlockers`: every reason the best did not reach `auto`.

`best` is set whatever the band, as the first alternative. An ISRC-verified candidate's `confidence` is at least 0.95 whatever its text score, since an item in another script ("アイドル" for "Idol") scores low on text.

### Steps

1. **Normalize** with the core text helpers, in their documented order: `stripPresentationNoise`, `normalizeText`, a leading credit of known artists removed ("The Weeknd - …", "YOASOBI「…」", "BTS (방탄소년단) '…'"), then `splitTitle`. Version tags come from the qualifiers and the album, never from the title proper, so "Live Forever" is not live while a track of "MTV Unplugged in New York" is. Tags are compared by family: live, unplugged, session and tour are one family, so "(Live)" against an unplugged album is not a mismatch.
2. **ISRC gate.** The top five items of the songs search, then the unfiltered top-result card, then the retry. An item passes only if it is a song (`ATV`), its artist similarity is at least 0.5, its duration is within max(5 s, 2 %), no strong version family differs, and its title similarity is at least 0.8; the title check is skipped only for item #1 of a songs search when the two titles are in different scripts ("Idol" / "アイドル"). When several items of one search pass, the one from the source's album wins. A trusted ISRC (`catalog`, `musicbrainz-exact`) that passes is ISRC-verified and goes straight to `auto` (given the setting and a duration); one that never passes caps the match at `suggest`. A fuzzy ISRC is a hint only: it breaks ties and caps nothing.
3. **Score** every candidate: **0.40 × title + 0.35 × artist + 0.25 × duration**.
   - Title: the larger of Dice on character bigrams and token-set overlap, between title cores only.
   - Artist: the share of the source's artists found among the candidate's (featured artists in its title included); a name matches by Dice ≥ 0.8, or when the candidate's name contains it as whole words and it has two words or more. Channel decorations (" - Topic", "VEVO", "Official") are ignored.
   - Duration: 1 within 2 s, 0.85 within 5 s, 0.4 within 10 s, else 0.
   - Penalties: a version family on one side only −0.45 (strong), −0.15 (medium), −0.03 (soft); two remixes naming different remixers −0.45; an uncredited featured artist −0.45; explicit against clean −0.15; |Δ| > 10 s −0.15, > 20 s −0.35.
   - Caps: title below 0.5 caps at 0.40; no shared artist caps at 0.45.
4. **Rank**: ISRC-verified first, then by score; equal scores (after the 1.0 cap) go to the candidate that agrees with the source's album, then year, then label, then an ISRC hint, then page order. In Music + Video mode the best song wins when it reaches `suggest`.
5. **Band**: `auto` only when the Auto setting is on (`options.auto`, off unless 1.12's held-out report passes), the source has a duration, and the best is ISRC-verified, or all of these hold:
   - score ≥ 0.80 and title similarity ≥ 0.80;
   - |Δ| ≤ max(5 s, 2 %);
   - a margin of ≥ 0.05 over the best candidate that is not the same version (same title core, version, remix, explicit flag and artist, within the window of each other);
   - it is a song, and its explicit flag agrees with the source's;
   - the classical guard does not fire (a classical-looking title needs an album match);
   - the re-recording guard does not fire (below).

   Otherwise `suggest` from 0.60 (and for any ISRC-verified match the setting or no-duration mode keeps from `auto`), else `none`. User uploads (`video`) and official videos never reach `auto`.

### Re-recording guard

Any trigger makes the best `suggest`:

1. **Rivals**: other songs that look like the best (title core, version, artist, explicit flag) inside the duration window come from different releases (album IDs, release years or labels), and nothing ties the best to the source's release: it is not ISRC-verified, and neither its album, its year nor its label agrees with the source's. An album counts only when its name is distinctive: not a generic compilation title ("Greatest Hits", "The Very Best of …") and not shared by another release of the source's artist on the pages (two releases are named "The Everly Brothers").
2. **ISRC miss**: the source's trusted ISRC never passed the gate.
3. **Conflicting release facts**: the best's label (℗ line or "Provided to YouTube by") shares no identifying word with the source's, or its release year is two years or more before the source's (a lead single a year before its album is fine; a reissue later is fine).
4. **Measured fallback** (`requireReleaseAgreement`, off by default): text-only Auto needs a distinctive album match or the same release year. 1.12 turns it on if it still finds wrong Auto plays.

### No-duration mode

Spotify's "Download your data" rows have names but no duration or ISRC. Without a source duration the duration term is dropped (title and artist are scaled to 1), the duration penalties and windows do not apply, and the match never goes beyond `suggest`.

### Official video → song

A song link from the video's source wins (`songForVideo`), and is always `auto`: it is not a guess. Otherwise a song matches only with title similarity ≥ 0.8, artist similarity ≥ 0.5, no strong version mismatch, and a duration no longer than the video plus 5 s (a shortened video never maps to the album version). There is no duration window, because videos have intros. The best match is `auto` with the Auto setting on and `suggest` without it; with none the band is `none` and Music mode hides the video.

## Thresholds

`DEFAULT_MATCH_THRESHOLDS` holds the values; `options.thresholds` overrides them, so 1.12 can tune them on its calibration split.

| Parameter | Value | Evidence (2026-10-25) |
|---|---|---|
| Auto score / margin | 0.80 / 0.05 | Exact candidates: median score 1.00 (p10 0.96); covers at most 0.45; different songs at most 0.40 |
| Auto title similarity | 0.80 | Added here: another song by the same artist with a partly shared title ("Twist It Up" for "The Twist", same album, same length) scores 0.81 |
| ISRC gate title similarity | 0.80 | §12 names 0.5. All 44 same-script ISRC hits in the golden set score 1.00 (2 more are in another script, which item #1 may be); "Twist It Up" for "The Twist" scores 0.53 at the same length and must never pass |
| Duration window | max(5 s, 2 %) | Exact candidates: median difference 1 s, maximum 4 s, 50 of 58 within 2 s |
| ISRC gate | Top 5, every check, a retry, the top-result card | First run 16 of 16 at #1; fresh runs 9 of 16 at #1, 6 at #2, 1 missing. Misses return unrelated filler. ISRCs are shared by unrelated tracks |
| Re-recording guard | Demote to Suggest | Wrong Auto plays on the held-out set: The 1975 "The 1975" (2013 vs 2016), "The Twist" (ABKCO vs TEEC), "Bye Bye Love" (1957 vs 1964) |
| Classical guard | Keep | Without it, Yo-Yo Ma's 1983 and 2018 recordings both scored 1.00 |

## Where this goes beyond ARCHITECTURE.md §12

Each of these only ever keeps a match from `auto`, and each was checked against the golden set:

- **Title similarity of 0.8** for anything that plays without asking: in the ISRC gate (§12 says 0.5) and for a text match (§12 has no title floor besides the 0.40 cap below 0.5). Another song by the same artist whose title is partly the same, at the same length, scores 0.53 for the title and 0.81 overall; every same-script ISRC hit in the golden set scores 1.00. Both are `DEFAULT_MATCH_THRESHOLDS` entries for 1.12 to tune.
- **Title cores only.** The research scorer also compared whole titles at 0.9 weight; a shared qualifier then made "If This Was A Movie (Taylor's Version)" score 0.80 against "Love Story (Taylor's Version)".
- **Explicit against clean** costs 0.15 and blocks `auto`: the ISRC index treats them as different masters.
- **Remixes by different remixers** count as a strong version mismatch.
- **Version tags by family**, so a live qualifier against an unplugged album is not a mismatch.
- **Artist containment one way, and for names of two words or more**: "Bill Haley" does not count as "Bill Haley & His Comets", nor "Queen" as "Queen Naija".
- **Rivals:** the guard fires unless the best itself is tied to the source's release (not merely one of the rivals), and an album name ties it only when it is distinctive.
- **Conflicting years:** a release two or more years before the source's conflicts; a later one (a reissue) or one a year earlier (a lead single) does not.

## Golden dataset

[`__fixtures__/golden.json`](__fixtures__/golden.json) holds the cases `golden.test.ts` replays offline. Every case names its provenance: the research runs of 2026-10-25 (YouTube Music search pages, YouTube descriptions, MusicBrainz, Deezer and Spotify `metadata/4` facts), copied as facts only. Items with `x-` IDs are constructed, where no measured page exists (the studio versions next to Spotify Singles, the sped-up pair).

- `pages`: shared search pages, each with its provenance and query. Items keep `musicVideoType` as `kind`, whole-second durations as YouTube shows them, and the album's browse ID.
- `cases`: a source (or a video), the pages it sees (a page key, `{ page, top }` for the first items only, or inline items), release facts, labels and the expectation.
- Labels: `exact` (the source recording on any release, a remaster included), `equivalent` (the same audio in another form), `wrong`, `unknown`. An `auto` pick must be `exact` or `equivalent`; an unlabeled item counts as `unknown`.

The tests run every case with the Auto setting on and off, and check the totals: zero wrong Auto plays, at least 85 % Auto on the mainstream cases, the three held-out failures replayed with the ISRC step off ending in Suggest, and no squatter, cover or same-artist filler passing the gate. Categories cover mainstream, regional and cross-script titles, classical re-recordings, Taylor's Version, explicit and clean masters, live and studio, remix and original, radio edits, sped-up releases, Spotify Singles, compilation-only ISRCs, ISRC squatters (GBAYE0601696, QMFMF2447070), same-artist filler, no-duration rows, official videos and Music + Video mode.

To add a case, record the pages with the research tooling of stage 1.12 (or copy them from a provider fixture), label every item you can, write the expectation you believe is right, and run `scripts/run.sh pnpm vitest run packages/core/src/matching`.
