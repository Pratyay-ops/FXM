# The recommendation engine (`@fxm/core`)

Stage 3.3: what Home shows and why, computed on the device from the user's taste (stage 3.1's affinity) and the candidates the recommendation sources collect (stage 3.2). Stage 3.4 adds endless radio, which keeps a queue going from the same pieces ([below](#endless-radio-stage-34)). Nothing leaves the device.

- **Pure and deterministic.** No network, no storage, no clock and no global randomness: the time (`now`), the local time's offset from UTC and the random source are inputs. The same input always gives the same shelves, whatever order the candidates come in.
- **Fail closed.** Candidates, profile entries and stored lists that can't be read are left out, never thrown on.
- **Mode-aware.** In Music mode every list holds songs only; in Music + Video anything but episodes (`fitsMode`, the rule of `@fxm/sources/recommend`'s `tracksForMode`).

## How Home is put together

```
planSeeds(taste)            which tracks and artists to ask the sources about, and for which parts
   ↓ the app: collector.collect(seed, ctx, { parts }) for each seed    (network, stage 3.2)
poolCandidates(candidates)  every listing of one song (or artist) merged, with its evidence
planExpansions(pool)        the few similar artists and song searches worth turning into tracks
   ↓ the app: artist top tracks, song searches                         (network, a few calls)
buildHome(input)            the shelves, from the taste, the candidates and last build's lists
```

The app runs the network steps (`apps/web/src/features/home`); everything else is here.

```ts
import { buildHome, indexTaste, planExpansions, planSeeds, poolCandidates } from '@fxm/core'

const taste = indexTaste(profile, now)
const seeds = planSeeds(taste, { mode })
const candidates = (await Promise.all(seeds.map((s) => collector.collect(s.seed, ctx, { parts: s.parts })))).flatMap((c) => c.candidates)
const feed = buildHome({ profile, taste, candidates, seeds, mode, now, utcOffsetMinutes, stable, spotifyConnected, sourceShelves })
save(feed.stable)   // Discover and the Daily Mixes, kept for their week and day
```

`taste` is optional: `buildHome` indexes the profile itself unless it gets the index made at the same `now`. The profile should hold every affinity entry the candidates name, not only the top of the affinity: the app reads the top few hundred, then the entries of the candidates' tracks and main artists (`completeProfile` in `apps/web/src/features/home/feed.ts`), so a song or artist the user skips (skips, no affinity) or a song played long ago is never taken for an unheard one.

## Candidates

The engine reads candidates in the one format of `@fxm/sources/recommend` (`RecCandidate` here, which a `RecommendationCandidate` is as it is): a `track`, a `song-search` (a song known by artists and title only) or an `artist`, each with its `source`, `part`, `seed`, `rank` and `score` (0–1 within its list).

**Pooling** (`poolCandidates`) merges listings that share a key: a track's `entityKey` or the **song identity** (`songIdentity`: main artist and title proper, normalized, versions folded, so "Creep" from YouTube Music and "Creep - Remastered" from Spotify are one song; worked out once per title and artists, and remembered, since a build asks for the same songs many times). Each pooled song keeps one piece of evidence per list (source, part and seed), whose **strength** is the score weighed by the source, the part (`DEFAULT_EVIDENCE_WEIGHTS`) and the seed (how much the user likes it, 0.5–1). Its **similarity** combines the strengths like independent votes, `1 − Π(1 − s)`, so songs several sources agree on rise. The track shown is the listing that plays most directly: a local file, then YouTube Music, Internet Archive, Jamendo, plain YouTube, and Spotify last (it still needs matching); a cover another listing has fills a gap. A radio never recommends its own seed.

**Expansions** (`planExpansions`): similar artists must become songs, and song searches tracks, which costs requests, so the engine picks the few worth it: artists by similarity, less the better the user knows them (Discover is about new artists), and none the pool already has three songs by; songs the user doesn't know, by score. `artistTrackCandidates` and `songTrackCandidates` turn what the app fetched back into candidates that keep the original evidence.

## Taste

`indexTaste(profile, now)` reads stage 3.1's affinity entries (tracks with their cached metadata, artists, tags), the recent plays and the onboarding picks, and decays everything to `now`. Affinities are normalized on a log scale against the strongest of their kind, `log(1 + a) / log(1 + max)`. Artists are keyed by `artistKeyOf` (the affinity's key without YouTube's " - Topic" and "VEVO"), so entries a channel suffix split are one.

- **Known** songs are those the user played, liked or saved, matched by track and by song identity: a song played on Spotify counts as played on YouTube Music.
- **Liked enough** (`likedEnough`) to build on: an affinity of at least half a play, and more listening than skipping.
- **The cold start:** fewer than three artists with an affinity (`MIN_TASTE_ARTISTS`). Home then asks for artists and genres. **Onboarding picks** (`TastePicks`) count like likes made when they were picked (`pickContributions`), so they seed the first mixes and fade with the affinity's 14-day half-life as real listening takes over. A picked artist counts as one the user knows (`familiarity` 1, `picked`): they named it, so Discover, which is about artists they hardly know, leaves it out, and `planExpansions` doesn't take it for a new one.

## Ranking

ARCHITECTURE.md §13: **score = affinity + similarity + popularity + novelty − skip penalty − recently-played penalty**, each term from 0 to 1 (`scoreTerms`) and weighed per list (`SCORE_PRESETS`):

| Term | From 0 to 1 |
|---|---|
| affinity | `1 − (1 − track)(1 − 0.8·artist)(1 − 0.4·tags)`: the track itself, its artists (featured ones at half) and the mean of its top three tags |
| similarity | The pooled similarity (the Because shelves use only their seed's evidence) |
| popularity | The source's 0–100, scaled; 0.5 when unknown |
| novelty | 0 for a known song; otherwise 1, less up to half as the user knows the artist |
| skip penalty | The share of skipping for the track, or half of it for its main artist |
| recently-played penalty | `2^(−age / 1 day)` |

| Preset | affinity | similarity | popularity | novelty | skip | recent |
|---|---|---|---|---|---|---|
| `quickPicks` | 1 | 0.8 | 0.1 | 0.15 | 1 | 1 |
| `because` | 0.4 | 1.2 | 0.15 | 0.4 | 1 | 1 |
| `discover` | 0.5 | 1 | 0.2 | 1 | 1 | 1 |
| `mix` | 1 | 0.8 | 0.1 | 0.2 | 1 | 0.5 |
| `radio` (for 3.4) | 0.6 | 1.2 | 0.1 | 0.3 | 1.2 | 1 |

A recommendation list never holds a song with a score of 0 or less, nor one whose track or main artist the user mostly skips (at least one whole skip, and twice as much skipping as listening): `welcomeSongs`, with `mostlySkipped`.

**History de-duplication** (`filterHistory`): leave out songs the user knows (`unheard`), songs played within a time (`playedWithinMs`), songs among the last N plays (`lastPlays`, for 3.4's "no repeats within N tracks") and given keys (`exclude`).

**Diversity** (`diversify`, `createPicker`): maximal marginal relevance, `λ · relevance − (1 − λ) · max similarity to what was picked`, with relevance the score scaled to 0–1 and similarity 1 for the same main artist, 0.7 for a shared credited artist and up to 0.5 for shared tags (`songSimilarity`). A hard **per-artist cap** counts every credited artist, so "feat." can't sneak a third song in. A list never holds a song twice. A pick does only the work it needs: an item's similarity to what the list holds is brought up to date when the item is weighed, and the search stops at the first item no later one can beat (an item is worth at most `λ · relevance`), so a list of a thousand songs costs little more than one of fifty. The picks are exactly those of weighing every item every time (`diversify.test.ts` compares them on random lists).

## Home's shelves

| Shelf | What it holds | Limit · cap · λ |
|---|---|---|
| Quick picks | Favourites and new songs, by the `quickPicks` weights; nothing played in the last 12 hours | 20 · 2 · 0.75 |
| Daily Mix 1–6 | One per cluster of the user's top artists: an artist and up to three of the top artists the sources link to it (by the pool's evidence, at least 0.25). At most half favourites by those artists, spread evenly from the first song; the rest new songs by them or suggested for them, not played in 3 days. Changes once a day | 30 · 5 · 0.6 (at least 10 songs) |
| Discover | Songs the user never played, by artists they hardly know (familiarity below 0.8; an artist they picked counts as known). Changes once a week | 30 · 2 · 0.6 (at least 6) |
| Because you listened to X | For each of up to three recent plays that weren't skipped, one per artist: what the sources suggest for it, new to the user | 12 · 2 · 0.7 (at least 4) |
| On repeat | The user's songs played twice or more and lately (within 30 days), liked enough, by affinity | 15 · 3 · 0.9 (at least 3) |
| Rediscover | Songs played three times or more, or liked, and untouched for 30 days, by the affinity they had | 15 · 2 · 0.8 (at least 3) |
| Spotify's sections | The personal home of a connected Spotify account (stage 3.5), as Spotify gives it, filtered to the mode; only with `spotifyConnected` | 6 sections |

**No song shows twice** across Quick picks, Discover, the Because shelves, On repeat and Rediscover (the mixes are lists of their own). A Discover kept from earlier in the week and the user's own shelves (On repeat, Rediscover) take their songs first. Then Quick picks, the Because shelves and a new Discover **draft** the pool between them: they take turns picking their next song by MMR, so in a small pool each gets a share instead of the first taking everything. A list left below its minimum is dropped and the draft runs again without it.

`DEFAULT_HOME_OPTIONS` holds every number above; `buildHome` takes overrides (`options`). Titles are the plan's English names; the app may show its own.

## Lists that stay put

**Discover** stays the same all week (ISO weeks, from Monday) and the **Daily Mixes** all day, in the user's local time (`utcOffsetMinutes`). Their noise comes from random sources seeded with the period (`seededRandomFor('discover', '2026-W44', mode)`), and a build returns the lists to keep (`HomeFeed.stable`): the app stores them and passes them back, and the next build reuses them while the period and catalog mode hold (one entry per kind and mode). A Discover of fewer than 10 songs isn't kept, so a thin one built during a cold start doesn't last the week. Stored lists are untrusted: `sanitizeStableShelves` keeps only well-formed entries and tracks.

Quick picks' noise comes from the `random` input, by default a source seeded with the hour, so rebuilding Home within an hour changes nothing.

## Endless radio (stage 3.4)

`radio.ts` keeps a queue going: when it runs low, it grows with songs like the last plays, ranked by the same pieces as Home. The app runs the library reads and the one network call (`apps/web/src/features/autoplay`); everything else is here.

```
radioShortfall(queue)                  4 tracks once fewer than 3 remain after the current one; 0 with repeat on
planRadioSeeds(taste, { mode, current })   the last 5 plays of the session, the track playing now first
nextRadioSeed(seeds, isCached)         the one seed whose radio to fetch now: the heaviest not cached
   ↓ the app: collector.collect(seed, ctx, { parts: ['radio'] })   (network, one call, cached)
buildRadioBatch(input)                 the songs to add, from the radios of every seed at hand
```

**Seeds** are the last 5 plays (`seedPlays`) of the listening session: the track playing now, then the history's plays back to the first pause of more than 2 hours (`sessionGapMs`, measured from the end of a play). Of those, a play the user skipped seeds nothing, however much they like its song: `RecentPlay.skipped`, which the app sets with `skippedEarly` (skipped before half of it played; a later skip, say of an outro, is a listen, as the affinity counts it). A played track also seeds only when the user likes it enough (`likedEnough`: at least half a play, more listening than skipping), the playing one unless they skip it more than they listen to it. Never a track the mode hides (`modePolicy`: an official music video seeds in Music mode too, since the recommendation sources start its radio from its song), one by an artist the user mostly skips, or a second listing of one song. When the user skipped all of them, the newest play of the session they didn't skip seeds alone. A seed's weight is how much the user likes it (`seedWeight`, 0.5 to 1), less 15 % for each play since it, down to 40 %.

**One radio fetch per extension.** `nextRadioSeed` names the heaviest seed whose radio the app hasn't cached; the app fetches it and keeps every seed's radio for a while, so the batch blends the radios of every seed at hand. A batch is 4 tracks (`batchSize`), so the play the last extension fetched for is still among the last 5 plays at the next one when the user plays on.

**The batch** (`buildRadioBatch`):

1. Pool the candidates of the seeds' radios, each listing weighed by its seed's weight; candidates of other seeds count for nothing. Songs without a track (a search would cost requests) and tracks that can't play unattended (`playsUnattended`: a Spotify track plays only through a match, which a queue skips until the user reviews it) are left out; Spotify's listings still raise the songs another source suggests too.
2. Score with `SCORE_PRESETS.radio` and a little noise (`jitter`, 0.05) from the injected `random`, by default seeded with `now`.
3. Leave out what `welcomeSongs` refuses, songs among the last 50 plays (`noRepeatTracks`: "no repeats within N tracks"), everything in the queue, and the keys the app excludes (the radio's songs the user removed from the queue).
4. Diversify with MMR (λ 0.7) and a cap of 2 per artist, counting the tracks already up next, from which the batch also keeps its distance.

**Likes and skips retune it** through stage 3.1's signals, which the app reads afresh for every extension: a play the user skipped seeds nothing, its song and artist score lower (the skip penalty), and a song or artist they mostly skip never comes; a like makes its song a heavier seed, whose radio counts more and is fetched sooner, and lifts every song by its artist.

`DEFAULT_RADIO_OPTIONS` holds every number above; each function takes overrides (`resolveRadioOptions` reads them defensively). Like Home, the radio is pure and deterministic: the time and the noise are inputs.

## Tests

`*.test.ts` build taste profiles from listening histories through stage 3.1's own `AffinityIndex` (`test-fixtures.ts`) and run on a fixed clock (Monday 2026-10-26). `home.test.ts` builds a whole Home from a fictional history and checks each shelf, the cross-shelf de-duplication, the caps, the modes, the Spotify sections, the cold start, determinism under reordered candidates, and the lists kept for their week and day. `diversify.test.ts` checks MMR's invariants on 200 random lists. `radio.test.ts` checks when a queue needs more, the seeds of a session (skips, a favourite skipped just now, late skips, likes, the current track, sessions, modes and music videos, the fall-back), which radio to fetch, and the batch: blending, the caps, no repeats, unattended playback, retuning by skips and likes, modes and determinism.
