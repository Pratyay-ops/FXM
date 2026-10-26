# Matching evaluation: the recorder (`eval`)

The live half of stage 1.12: it builds the labelled set's inputs from public data, records the YouTube Music pages the matching planner asks for, drafts the labels and writes the owner's review checklist. The offline half (the replay, the label rules, the report and the Auto switch) is in [`@fxm/core`'s `matching/eval`](../../../core/src/matching/eval/README.md), which also describes the set itself.

Everything here runs on the owner's machine, from Node, through the same providers and transports the apps use: Spotify (stage 1.5), MusicBrainz (1.6), the YouTube Music provider (1.3) and `@fxm/platform`'s Node transport with the shared request budget (1.2). Nothing runs on a server, and nothing here is part of the apps.

## Commands

Each phase is a Vitest "test" that runs only when `FXM_EVAL` names it (`commands.test.ts`); the network phases also need `FXM_LIVE=1` and a residential connection. Add `--silent=false` to see the progress lines.

| Phase | Command | Network |
|---|---|---|
| Inputs | `FXM_LIVE=1 FXM_EVAL=inputs scripts/run.sh pnpm vitest run packages/sources/src/eval/commands.test.ts --silent=false` | Spotify, MusicBrainz |
| Record | `FXM_LIVE=1 FXM_EVAL=record scripts/run.sh pnpm vitest run packages/sources/src/eval/commands.test.ts --silent=false` | YouTube Music |
| Label | `FXM_EVAL=label scripts/run.sh pnpm vitest run packages/sources/src/eval/commands.test.ts --silent=false` | none |
| Apply the review | `FXM_EVAL=apply-review scripts/run.sh pnpm vitest run packages/sources/src/eval/commands.test.ts --silent=false` | none |

`FXM_EVAL=all` runs inputs, record and label in a row. Options:

- `FXM_EVAL_PLAN`: `full` (the default, about 370 tracks) or `proof` (8 tracks);
- `FXM_EVAL_LIMIT`: at most this many new groups (inputs) or groups (record) in this run;
- `FXM_EVAL_CSV`, with `FXM_EVAL_CSV_PUBLISH=1`: the path of the owner's Exportify-style CSV, whose rows `inputs` adds as `csv` groups (see [the owner's own exports](#the-owners-own-exports));
- `FXM_EVAL_SHORT=1`: record a full set even though it has fewer held-out groups than planned (see below);
- `FXM_EVAL_RECHECK=1`: plan every recorded group again and fetch any page that is missing, after a change to the matching planner that did not bump `MATCHER_VERSION` (offline for complete groups).

After recording and labelling, format the JSON and write the report again:

```sh
make format
scripts/run.sh pnpm vitest run packages/core/src/matching/eval -u
```

## Recording the full set

```sh
FXM_LIVE=1 FXM_EVAL=all scripts/run.sh pnpm vitest run packages/sources/src/eval/commands.test.ts --silent=false
make format
scripts/run.sh pnpm vitest run packages/core/src/matching/eval -u
```

Then commit `packages/core/src/matching/eval/fixtures/groups/`, `REPORT.md` and `REVIEW.csv`. What it costs:

| Phase | Requests | Time |
|---|---|---|
| Inputs | Spotify: about 30 playlists and searches, one `metadata/4` per track (about 370), plus the token; paced at 1 per second. MusicBrainz: about 12 batched exact-path lookups, one fuzzy search per track (about 370), at 1 per second in MusicBrainz's shared queue | about 15–20 minutes |
| Record | YouTube Music: 1 to 9 pages per track, about 1,300 in all, at least 5 s apart and at most 500 an hour (the budget keeps 100 of its 600 an hour for the user) | 2½–3 hours |
| Label | none | a few minutes |

**The set's size.** At the end of the inputs phase the command prints how many groups fall in each split. The record command refuses to start a full set with fewer than 215 held-out groups (`MIN_PLANNED_HELD_OUT`: the gate's 200 recorded groups, with room for groups that fail to record), and says so; add sources to `INPUT_PLANS.full` or raise their takes and run inputs again, or set `FXM_EVAL_SHORT=1` to record the set anyway.

**Resumable.** A run can stop at any time (Ctrl-C, `kill`, sleep, a crash, two bot checks): run the same command again and it goes on. The tracks each input source gave are kept in the checkpoint, so sources are read once; each group's file is written as soon as its inputs exist, and again after every page it gets. A group is marked done with a fingerprint of its inputs once all of the pages they need are in, so a group whose inputs change later (a later inputs run completes them once MusicBrainz answers, or the rules that build them change) is planned again, and only its missing pages are fetched. The checkpoint (`state/checkpoint.json`, not in git) also keeps the request budget's state, so a new run honours the hour's calls and a bot-check pause. The first Ctrl-C (or `SIGTERM`) stops the run cleanly and saves the checkpoint; a second one ends the process at once.

**The budget.** The recorder is bulk work in `@fxm/platform`'s request budget: before each page it waits for a bulk slot (`whenAvailable('bulk')`), outside the provider's request timeout, and the provider's `fetch` is the Node transport's `bulk` fetch, which draws the slot. At the first `LOGIN_REQUIRED` or 429 the budget pauses bulk work for 30 minutes (doubling up to 4 hours); the recorder writes the pause to the checkpoint at once, so a run killed during the wait still honours it, logs when bulk work resumes, and waits. After two bot checks in one run it stops, keeping everything it recorded, so a flagged IP address is left alone. Run it again later.

**Failures.** A page YouTube does not have (`NotFound`) is recorded as such, and the replay skips it as a live match would. A page that keeps failing for another reason (the network, or an answer the parsers do not understand) is not recorded: its group is deferred to the next run. Three groups deferred in a row stop the run, since YouTube has probably changed or the network is down. In the inputs phase, a track Spotify does not know is skipped for good, and any other failure only for this run; a Spotify rate limit, or three Spotify failures in a row, stop reading Spotify for this run, and three MusicBrainz failures in a row stop its fuzzy searches. A source that cannot be read (a removed playlist) is reported, and the plan goes on without it.

## Inputs from public data

The plan (`INPUT_PLANS.full` in `inputs.ts`) takes tracks, in order, from Spotify's public charts and editorial playlists and from Spotify searches. Each source takes its number of tracks among those no earlier source took (a track two charts share is one group, and counts for the first), so the takes add up to about 370 distinct tracks and the held-out split (70 %) holds about 260:

| Category | Sources |
|---|---|
| Mainstream | Top 50 Global, USA and UK; Today's Top Hits; All Out 60s to 2010s; Rock Classics |
| Regional | Top 50 India, Japan, South Korea, Brazil, Mexico, Nigeria and Egypt |
| Classical | Classical Essentials; a search for "Symphony No. 5" |
| Long tail | Fresh Finds |
| Spotify Singles | Searches for "Spotify Singles" and "Recorded at Spotify Studios" |
| Re-recordings | Searches for "Taylor's Version", "Re-Recorded" and "Rerecorded" |
| Compilations | Searches for "Now That's What I Call Music" and "Greatest Hits" |
| ISRC squatters | The two inputs the research found (`FIXED_INPUTS`) |

A track's categories come from its facts, not from the source alone (see `categoriesOfInput`): a chart track with a popularity under 50 is not mainstream. Each track gets the data-export row and the MusicBrainz inputs described in the core README. Charts change daily; each group's provenance says which playlist and position it came from and when the source was read, and names the source that created the group, which is how a source counts its own groups when a run resumes.

## The owner's own exports

`FXM_EVAL_CSV` adds an Exportify-style CSV (any version of its columns; see `csv.ts`). **Its rows are published:** they become groups of the labelled set, which is committed to this public repository with their titles, artists, albums and Spotify IDs. So use a playlist you are happy to publish, not your liked songs, and set `FXM_EVAL_CSV_PUBLISH=1` to confirm; the inputs command refuses the CSV without it. The groups' provenance names the row ("the owner's Exportify-style CSV, row 12"), never the file.

Rows from Spotify's "Download your data" export are made from the Spotify rows instead (the export has names and URIs but no duration or ISRC); stage 3.6 reads the export itself.

## What is stored

Only public catalog data: titles, credits, albums and their browse IDs, durations, explicit badges, release facts from descriptions and the lines YouTube generates for label uploads (never the rest of a description), Spotify's and MusicBrainz's public facts, and the rows of a CSV the owner chose to publish. No token, TOTP code, secret, visitorData, cookie or IP address is written anywhere; the checkpoint holds the budget's call times, the tracks of the sources read and the run's progress.

## Code

| File | What |
|---|---|
| `commands.test.ts` | The commands, wired to the real providers, `@fxm/platform`'s Node transport and the files |
| `inputs.ts`, `csv.ts` | The input plans and builder; the Exportify CSV reader |
| `pages.ts` | One page key → one provider call, filed in the labelled set's format. The mapping from a planner request to a provider call is the one a live `AudioSource.match` needs |
| `recorder.ts` | The resumable recorder (`recordGroups`) |
| `platform.ts` | `@fxm/platform`'s budget and Node transport, loaded at run time by path (the platform depends on this package, so it cannot be a dependency of it), with the budget's state in the checkpoint; `platform.test.ts` checks the binding offline |
| `review.ts` | Labels, the review checklist, and applying the owner's decisions |
| `store.ts` | The files (`fileStore`) and the checkpoint; `memoryStore` for tests |

The tests (`*.test.ts` besides `commands.test.ts`) run offline with fake providers.

## Proof run

Recorded from a residential connection in India on 2026-10-25 (UTC), with `FXM_EVAL_PLAN=proof`: 8 tracks, 17 Spotify and 13 MusicBrainz requests for the inputs, then 30 InnerTube requests (28 pages and two `sw.js_data` reads) in two runs: the first stopped after 3 groups (`FXM_EVAL_LIMIT=3`), the second resumed with the other 5 and fetched none of the first run's pages again. The bulk spacing held: 5 s between InnerTube requests.

After the data-export rows were changed to name one artist (the first review of the stage), the inputs builder, run with providers that refused every request, rebuilt the inputs of 4 groups, and a record run on the old checkpoint planned all 8 groups again and fetched only the 3 pages the new rows needed, plus one `sw.js_data` read (2026-10-25, 23:55 UTC).
