# Matching engine

`@fxm/core`'s matching engine finds the YouTube Music song for a track from another catalog (a Spotify track, an import row, a MusicBrainz recording), and the song for an official music video in Music mode. It implements [ARCHITECTURE.md §12](../../../../docs/ARCHITECTURE.md#12-matching-engine-packagescoresrcmatching) as corrected by the research memo of 2026-10-25 (sections 6 and 11.7).

The engine is pure: no network, no clock, no storage. A provider fetches the pages the planner asks for and hands them over; the engine ranks the candidates and decides. Only the engine's API is exported from `@fxm/core` (`matchTrack`, `runMatch`, the planner, `matchVideoToSong`, `videoSongsQuery`, `parseReleaseDescription`, the types, the thresholds and the guards); the scorer stays internal.

## Using it from a provider

```ts
import { runMatch } from '@fxm/core'

// In AudioSource.match(track, ctx): no user settings needed.
const result = await runMatch(track, (request) => fetchPage(request, ctx), { mode: ctx.mode })
return result.candidates // best first; the best carries the verdict
```

`runMatch` asks the planner (`nextMatchRequest`) for each page, has `fetchPage` fetch it, files the answer (`addMatchResponse`) and returns `matchTrack`'s decision, with one set of options throughout. `fetchPage` makes the one InnerTube call a request names, through the request budget, and answers with a `MatchResponse` of the same kind:

- **A page it cannot fetch** (a network error, a bot check, a request the budget refuses): return `null`. The match goes on without that page, the planner never asks for it again, and the result is `incomplete`, so a cache does not keep it.
- **Cancellation** (`ctx.signal`): reject. `runMatch` rejects with the same reason.

Providers that drive the loop themselves call `nextMatchRequest(source, pages, options)` and `addMatchResponse(pages, request, response)` with the same options as `matchTrack`. `addMatchResponse` throws a `RangeError` for an answer of another kind, an ISRC search attempt out of order, and release facts keyed by anything but a requested track ID (a bare videoId would otherwise drop the facts and turn a guard off).

`track` is any `MatchSource`. A core `Track` is one; `AudioSource.match` takes `Track & MatchSourceExtras`, so callers pass along what the track type lacks: `label`, `albumType` and `isrcOrigin`. An ISRC is trusted unless its origin says otherwise, so a guess must always come with its origin, and never sits in `Track.isrc`. Stage 1.6's MusicBrainz helpers map like this:

| 1.6 result | `MatchSource` |
|---|---|
| `{ kind: 'exact', isrcs: [one] }` | `isrc: one, isrcOrigin: 'musicbrainz-exact'`: a pass verifies, a miss caps at Suggest |
| `{ kind: 'exact', isrcs: [first, …more] }` | `isrc: first, isrcOrigin: 'musicbrainz-exact-several'`: a pass verifies, a miss caps nothing |
| `{ kind: 'exact', isrcs: [] }` | No ISRC; the recording's length can fill a missing `durationMs` |
| `{ kind: 'hint', … }` | `isrcOrigin: 'musicbrainz-fuzzy'`: a hint for ranking only |

Any origin that is not one of these counts as a hint (`isIsrcOrigin` validates stored ones).

The pages are lists of core `Track`s in page order, as the YouTube provider returns them: `kind` from `musicVideoType`, the album with its browse ID, the duration, and `explicit: true` on songs with the explicit badge. A song without the mark counts as the clean master. Tracks of other sources (Internet Archive, Jamendo, local files) go in `pages.text` with `matchTrack(source, { text: tracks }, options)`; a candidate whose own ISRC is the source's is checked like an ISRC hit.

| Request (`nextMatchRequest`) | What the provider fetches | Filed as (`addMatchResponse`) |
|---|---|---|
| `isrc-songs` | YouTube Music songs search with the ISRC as the query (`attempt` 2 is the retry) | `isrcSongs[attempt - 1]` |
| `isrc-top-card` | Unfiltered search for the ISRC; only the top-result card | `isrcTopCard` (`null` when there is none) |
| `text-songs` | Songs search for "all artists + title" | `text` |
| `album-songs` | The same with the album | `album` |
| `release-facts` | The descriptions of the listed candidates, read with `parseReleaseDescription` | `releaseFacts`, keyed by the requested track IDs (a track left out counts as described with nothing to say) |
| `videos`, `youtube` | Music + Video mode only: the videos filter, then regular YouTube ("artists - title") | `videos`, `youtube` |

The plan costs one call when the ISRC passes at once, and seven at most in Music mode: the ISRC search, the top-result card, the retry, the text search, the album search and two descriptions. A fuzzy ISRC gets the first search only. The album search comes before the descriptions, so the descriptions cover its songs; when descriptions turn an Auto match into a suggestion, the album search follows and a song it brings to the top two is described too, within two descriptions in all. When Auto is out of reach whatever comes (no-duration mode, a trusted ISRC that missed), no description is fetched, and the album search runs only when no text candidate already reaches Suggest on the source's album. Queries drop a leading credit of the artists, so a video's "Chubby Checker - The Twist" searches for "Chubby Checker The Twist".

Official videos in Music mode go through `matchVideoToSong(video, songs, options)`, where `songs` is the songs search for `videoSongsQuery(video)`. A song link on the video (`Track.songId`, from YouTube Music's album pages) wins without scoring; pass `ignoreLink: true` when the linked song turned out not to be playable, which leaves the video `needs-song-match`.

## Applying the Auto setting

The engine never needs the user's settings. The best candidate carries a `verdict` (`AudioCandidate.verdict`, a `MatchVerdict`): the band it reaches with the Auto setting on, the blockers, and the `MATCHER_VERSION` that decided. The app applies the setting at play time:

```ts
const band = effectiveMatchBand(candidate.verdict, settings.autoMatch) // 'auto' | 'suggest' | 'none'
```

`effectiveMatchBand` gives `auto` only for an `auto` verdict of this matcher version while the setting is on, and `suggest` for a missing or malformed verdict. `MatchOptions.auto` (only `true` turns it on) changes `MatchResult.band` alone, never the verdict, so a stored candidate follows the setting as it changes.

Stage 2.6's match cache stores the verdict, the evidence and the signals, never a band with the setting applied. It drops entries whose `matcherVersion` differs from `MATCHER_VERSION` (bumped whenever the scoring, a guard or a default threshold changes), never keeps an `incomplete` result as final, and keys entries by the thresholds too if the app overrides them. Options read from storage or a config go through `sanitizeMatchOptions`; invalid thresholds (not a finite number in range) keep their defaults.

## What the engine decides

`matchTrack` returns a `MatchResult`:

- `band`: `auto` (plays without asking), `suggest` (plays only after an explicit user action, with "Not the right version?"; queues skip it and mark it "needs review", imports send it to the review list) or `none` (shows the alternatives and a manual search), with the Auto setting as `options.auto` gives it.
- `autoEligible`: whether the best clears every rule but the setting, the same as `best.verdict.band === 'auto'`.
- `best` and `candidates`: core `AudioCandidate`s, best first, each with `confidence` (the score), `evidence` (text for people) and `signals` (`isrcVerified`, `releaseId`, `releaseYear`, `label` from the ℗ line, `sourceAlbumMatch`). The best also carries the verdict.
- `isrc`: the gate's verdict (`verified`, `miss`, `hint`, `hint-miss`, `not-run`, `no-isrc`) with every rejected item and why.
- `autoBlockers`: every reason the best did not reach `auto`, `setting-off` included.
- `matcherVersion` and `incomplete` (a page was skipped).

`best` is set whatever the band, as the first alternative. An ISRC-verified candidate's `confidence` is at least 0.95 whatever its text score, since an item in another script ("アイドル" for "Idol") scores low on text.

### Steps

1. **Normalize** with the core text helpers, in their documented order: `stripPresentationNoise`, `normalizeText`, a leading credit of known artists removed ("The Weeknd - …", "YOASOBI「…」", "BTS (방탄소년단) '…'"), then `splitTitle`. Version tags come from the qualifiers and the album, never from the title proper, so "Live Forever" is not live while a track of "MTV Unplugged in New York" is. An album's name proper carries no tag whose word also names studio albums ("Magical Mystery Tour", "Live Through This", "LONG.LIVE.A$AP", "Sessions", "Stripped") unless it reads as a live recording ("Live", "Live 2003", "Live at Wembley"); brackets and dash suffixes always count ("Hotel California (Live)").
2. **ISRC gate.** The top five items of the songs search, then the unfiltered top-result card, then the retry. An item passes only if it is a song (`ATV`), its artist similarity is at least 0.5 (every source credit for a classical-looking title, since Spotify credits the composer), its duration is within max(5 s, 2 %) (an item without a valid duration fails), no strong version tag differs, its explicit mark agrees with the source's, it names no featured artist the source does not credit, and its title similarity is at least 0.8. Item #1 of a songs search may miss the title check when the titles are in different scripts ("Idol" / "アイドル"), and may name sidemen as featured artists when it is on the source's very album ("So What (feat. John Coltrane …)" on "Kind Of Blue (Legacy Edition)"). When several items of one search pass, the one from the source's album wins. A pass is ISRC-verified and goes straight to `auto` (given the setting and a duration); a `catalog` or `musicbrainz-exact` ISRC that never passes caps the match at `suggest`. A candidate whose own ISRC is the source's goes through the same checks.
3. **Score** every candidate: **0.40 × title + 0.35 × artist + 0.25 × duration**.
   - Title: the larger of Dice on character bigrams and token-set overlap, between title cores only.
   - Artist: the share of the source's artists found among the candidate's (featured artists in its title included); a name matches by Dice ≥ 0.8, or when the candidate's name contains it as whole words and it has two words or more. Channel decorations (" - Topic", "VEVO", "Official") are ignored.
   - Duration: 1 within 2 s, 0.85 within 5 s, 0.4 within 10 s, else 0. A duration that is not a finite number above 0 is none.
   - Penalties: a version tag on one side only −0.45 (strong), −0.15 (medium), −0.03 (soft), once per family and side; two remixes naming different remixers or mixes −0.45; an uncredited featured artist −0.45; explicit against clean −0.15; |Δ| > 10 s −0.15, > 20 s −0.35.
   - Version tags: a generic tag ("Live", "Remix", "Acoustic") is matched by any tag of its family on the other side; a specific one ("Unplugged", "Tiny Desk", "Take 3", "Club Mix", "Piano Version") only by the same tag. So "(Live)" against an unplugged album is fine, while "Take 2" for "Take 3", a VIP mix for a club mix, a piano version for "(Acoustic)" and a Tiny Desk concert for "Live" are mismatches. A radio edit and a single version count as the same edit.
   - Caps: title below 0.5 caps at 0.40; no shared artist caps at 0.45.
4. **Rank**: ISRC-verified first, then by score; equal scores (after the 1.0 cap) go to the candidate that agrees with the source's album, then year, then label, then an ISRC hint, then page order. In Music + Video mode the best song wins when it reaches `suggest`.
5. **Band**: `auto` only when the Auto setting is on, the source has a duration, and the best is ISRC-verified, or all of these hold:
   - score ≥ 0.80 and title similarity ≥ 0.80;
   - |Δ| ≤ max(5 s, 2 %);
   - a margin of ≥ 0.05 over the best candidate that is not the same version (same title core, version, remix, explicit mark and artist, within the window of each other);
   - it is a song, and its explicit mark agrees with the source's;
   - the classical guard does not fire: a classical-looking title ("Symphony No. 5", "Prelude in C", "BWV 1007", ": I. Prélude", not "Symphony" or "Adagio for Strings") needs an album that ties it to the source's release (below) and every source credit;
   - the re-recording guard does not fire (below).

   Otherwise `suggest` from 0.60 (and for any ISRC-verified match the setting or no-duration mode keeps from `auto`), else `none`. User uploads (`video`) and official videos never reach `auto`.

### Re-recording guard

Any trigger makes the best `suggest`:

1. **Rivals**: other songs that look like the best (title core, version, artist, explicit mark) inside the duration window come from different releases (album IDs, release years or labels), and nothing ties the best to the source's release: it is not ISRC-verified, and neither its album, its year nor its label agrees with the source's. An album ties it only when it is the same release by name: equal, equal without edition qualifiers ("Hysteria (Super Deluxe)"), or a reissue named after the album ("OK Computer OKNOTOK 1997 2017": years, numbers and edition words, with at most one other word). It never ties when either name is a compilation title ("Greatest Hits", "The Very Best of …", "The Everly Brothers' Golden Hits"), when a self-titled album is extended ("The Everly Brothers 1958" for "The Everly Brothers"), or when another release of the source's artist on the pages matches as well (two releases are named "The Everly Brothers"). Names that are only similar ("The Everly Brothers Sing", "Greatest Hitz") break ties between equal scores and do nothing else.
2. **ISRC miss**: the source's `catalog` or `musicbrainz-exact` ISRC never passed the gate.
3. **Conflicting release facts**: the best's ℗ label or "Provided to YouTube by" distributor shares no identifying word with the source's label, or its release year is two years or more before the source's.
4. **Measured fallback** (`requireReleaseAgreement`, off by default): text-only Auto needs an album that ties the best to the source's release, or the same release year. 1.12 turns it on if it still finds wrong Auto plays.

Triggers 1 and 3 read release facts from candidates' descriptions, which the planner fetches for the top two songs when the source has a label or a release date. The held-out replays depend on them: "The Twist" top five end in Suggest through the recorded descriptions of wvCuXYeMQ3U, and "The 1975" through a release year that stands in for a description nobody recorded. Without a source label or date, and with the fallback off, the 1975 page auto-plays the 2013 recording; `plan.test.ts` pins the description request that prevents it.

### No-duration mode

Spotify's "Download your data" rows have names but no duration or ISRC. Without a source duration (or with `NaN`, `0`, a negative or an infinite one) the duration term is dropped (title and artist are scaled to 1), the duration penalties and windows do not apply, and the match never goes beyond `suggest`.

### Official video → song

A song link from the video's source wins (`songForVideo`), and is always `auto`: it is not a guess. Otherwise only an official music video (`music-video`) is matched, against songs with title similarity ≥ 0.8, artist similarity ≥ 0.5, no strong version mismatch, and a duration no longer than the video plus 5 s (a shortened video never maps to the album version). The score has no duration term, because videos have intros. The bands are those of a track match: `auto` needs the setting, a score ≥ 0.80 (a "feat." version scores 0.55 and maps to nothing), a margin ≥ 0.05 over the best song that is not the same version, and no look-alike song from another release among the candidates, since nothing ties a video to one release ("The Twist" comes on six labels' releases; "Thriller" on the album and on "HIStory"). Otherwise `suggest` from 0.60, else `none`, and Music mode hides the video.

## Thresholds

`DEFAULT_MATCH_THRESHOLDS` holds the values; `options.thresholds` overrides them, so 1.12 can tune them on its calibration split.

| Parameter | Value | Evidence (2026-10-25) |
|---|---|---|
| Auto score / margin | 0.80 / 0.05 | Exact candidates: median score 1.00 (p10 0.96); covers at most 0.45; different songs at most 0.40 |
| Auto title similarity | 0.80 | Added here: another song by the same artist with a partly shared title ("Twist It Up" for "The Twist", same album, same length) scores 0.81 |
| ISRC gate title similarity | 0.80 | §12 names 0.5. All 45 same-script ISRC hits in the golden set score 1.00 (2 more are in another script, which item #1 may be); "Twist It Up" for "The Twist" scores 0.53 at the same length and must never pass |
| Duration window | max(5 s, 2 %) | Exact candidates: median difference 1 s, maximum 4 s, 50 of 58 within 2 s |
| ISRC gate | Top 5, every check, a retry, the top-result card | First run 16 of 16 at #1; fresh runs 9 of 16 at #1, 6 at #2, 1 missing. Misses return unrelated filler. ISRCs are shared by unrelated tracks |
| Re-recording guard | Demote to Suggest | Wrong Auto plays on the held-out set: The 1975 "The 1975" (2013 vs 2016), "The Twist" (ABKCO vs TEEC), "Bye Bye Love" (1957 vs 1964) |
| Classical guard | Keep | Without it, Yo-Yo Ma's 1983 and 2018 recordings both scored 1.00 |

## Where this departs from ARCHITECTURE.md §12

Stricter, so they only ever keep a match from `auto` (each checked against the golden set):

- **Title similarity of 0.8** for anything that plays without asking: in the ISRC gate (§12 says 0.5) and for a text match (§12 has no title floor besides the 0.40 cap below 0.5). Both are `DEFAULT_MATCH_THRESHOLDS` entries for 1.12 to tune.
- **Title cores only.** The research scorer also compared whole titles at 0.9 weight; a shared qualifier then made "If This Was A Movie (Taylor's Version)" score 0.80 against "Love Story (Taylor's Version)".
- **Explicit against clean** costs 0.15, blocks `auto` and fails the gate; a candidate without the explicit mark is the clean master.
- **Remixes by different remixers or mixes** count as a strong version mismatch.
- **Every gate check also on the explicit mark and featured artists**, and every source credit for a classical-looking title.
- **Artist containment one way, and for names of two words or more**: "Bill Haley" does not count as "Bill Haley & His Comets", nor "Queen" as "Queen Naija".
- **Rivals:** the guard fires unless the best itself is tied to the source's release (not merely one of the rivals), and only the same release by name ties it.
- **Official videos** get the bands, the margin and the rivals guard of a track match, not only §12's four rules.

Looser, each a deliberate exception for 1.12 to measure:

- **Version families.** A generic tag on one side meets a specific tag of its family on the other ("Live" and "Unplugged", which "About a Girl" on "MTV Unplugged in New York" needs), and a radio edit, a single version and an "Edit" are one edit. Two different specific tags are still a mismatch.
- **Conflicting years.** Only a release two or more years before the source's conflicts; a later one (a reissue, a compilation) or one a year earlier (a lead single) does not, although each is another release year.
- **Sidemen at the gate.** Item #1 on the source's very album may name featured artists the source does not credit.
- **One of several MusicBrainz ISRCs** (`musicbrainz-exact-several`) verifies on a pass but caps nothing on a miss.

## Golden dataset

[`__fixtures__/golden.json`](__fixtures__/golden.json) holds the cases `golden.test.ts` replays offline. Every case names its provenance: the research runs of 2026-10-25 (YouTube Music search pages, YouTube descriptions, MusicBrainz, Deezer and Spotify `metadata/4` facts), copied as facts. A case whose inputs were assembled or made up says so in `constructed`:

- `page`: a page assembled from recorded items, or emptied (the explicit/clean pages, the same-artist and cover filler pages, an empty top-result card or songs page);
- `items`: made-up items with `x-` IDs, or a recorded item changed (the studio versions next to Spotify Singles, the sped-up pair, the version-tag pairs, a song link on a search item, the review-round scenarios);
- `facts`: source fields or release facts that stand in for, or were removed from, what was recorded (the no-duration rows, composer-first credits, the 1975 replay's years).

Every other case replays recorded pages as they were. `golden.test.ts` checks the done-when totals on recorded cases too: at least 85 % Auto on the recorded mainstream cases, at least three recorded replays, and recorded squatter, filler, ISRC-miss, classical and video cases besides the constructed ones.

- `pages`: shared search pages, each with its provenance and query. Items keep `musicVideoType` as `kind`, whole-second durations as YouTube shows them, and the album's browse ID.
- `cases`: a source (or a video), the pages it sees (a page key, `{ page, top }` for the first items only, or inline items), release facts, labels and the expectation.
- Labels: `exact` (the source recording on any release, a remaster included), `equivalent` (the same audio in another form), `wrong`, `unknown`. An `auto` pick must be `exact` or `equivalent`; an unlabeled item counts as `unknown`.

The tests run every case with the Auto setting on and off (the verdict must not change), and check the totals: zero wrong Auto plays, at least 85 % Auto on the mainstream cases, the three held-out failures replayed with the ISRC step off ending in Suggest or on the right recording, and no squatter, cover or same-artist filler passing the gate. Categories cover mainstream, regional and cross-script titles, classical re-recordings and composer-first credits, Taylor's Version, explicit and clean masters, live and studio, remix and original, version tags, radio edits, sped-up releases, Spotify Singles, compilation-only ISRCs, ISRC squatters (GBAYE0601696, QMFMF2447070), same-artist filler, no-duration rows, official videos and Music + Video mode.

To add a case, record the pages with the research tooling of stage 1.12 (or copy them from a provider fixture), label every item you can, mark anything assembled with `constructed`, write the expectation you believe is right, and run `scripts/run.sh pnpm vitest run packages/core/src/matching`.

## Evaluation and the Auto switch (stage 1.12)

Whether the Auto band may be used at all is the matching config's call, `MATCHING_CONFIG`, which the held-out report of the matching evaluation decides; today it is off, so every match is a suggestion. Apply it with `isAutoMatchAvailable()` and `matchingOptions(settings)` rather than passing the user's Auto setting straight to the engine. The labelled set, the offline replay, the report and the config are in [`eval/`](eval/README.md); the recorder that fetches the set's pages is in [`@fxm/sources/eval`](../../../sources/src/eval/README.md).
