# Sync with GitHub

Optional sync of the library and settings between a person's devices (stage 8.4). FXM has no servers, so the copy lives in **one secret gist on the user's own GitHub account**, written with a token the user creates. Sync is off until the user sets it up in **Settings › Sync**.

## Setting it up

1. **A token.** The dialog links to GitHub's form for a new fine-grained token, already filled in: named "FXM library sync", with only the **Gists** permission (Read and write), expiring in 90 days (`NEW_TOKEN_URL` in `github.ts`). The user pastes the token.
   - FXM checks it with `GET /user`. A classic token that can do more than `gist` (its `X-OAuth-Scopes`) is refused: FXM holds no token with more power than sync needs.
   - The token stays on the device, in `localStorage` (`fxm.sync.v1`, see `sync-store.ts`). It never goes into the library database, a backup or the gist, and FXM sends it only to `api.github.com`. Turning sync off forgets it.
   - A fine-grained token can read and change **all** of the user's gists: GitHub has no per-gist permission. The dialog says what the gist holds.
2. **The gist.** FXM lists the account's gists for one with the manifest file `fxm-library-sync.json` (`findSyncGists`). GitHub doesn't document whether a fine-grained token lists secret gists, so the user can also paste the gist's link, which Settings shows (with Copy link) on any device that syncs.
3. **Confirmation.** Before anything changes, the dialog shows what the gist and this device hold. Joining merges the two, and removes nothing; creating makes a secret gist with this device's library. Sync is saved as on only after that first sync worked.

## What syncs

Records are the library backup's (`db/backup.ts`), and every one goes through the backup's guards (`db/validate.ts`) on the way in and out (`snapshot.ts`).

| Carried | Stays on each device |
|---|---|
| Playlists and their custom order, Liked songs and its order, the order of the playlists list | **Downloads**: it lists files stored on this device only |
| Likes, follows, reserved settings | Undo orders: Undo applies to this device's last shuffle or saved sort |
| Plays of the last 90 days | Older plays: sync never reads, sends or deletes them |
| Pins ("Not the right version?") | The matching engine's own decisions: a cache each device rebuilds |
| The track metadata the above use | The rest of the track cache |
| App settings: catalog mode and theme | Import progress: an import resumes on the device that runs it |

GitHub sends the whole gist back after every update (the API returns gist objects with up to 1 MB of each file), so the gist carries what other devices need and no more. Settings shows how large it is.

## How a sync works

`engine.ts`, `syncLibrary`:

1. **Read.** A conditional read with the gist's ETag; GitHub answers 304 when nothing changed, which doesn't count against its rate limit.
2. **Merge** the gist into the library, in **one transaction** that reads this device's library and writes only what changed (`library-io.ts`). A like made in another tab meanwhile waits for the transaction and is carried by the next sync, never overwritten.
3. **Push**, when the gist lacks part of the merged library: only parts whose content changed, and a new manifest, as one revision. Right before, a conditional read checks the gist is still the one this round merged; if another device pushed meanwhile, the round merges again.
4. **Save the base**: the library both sides agreed on, with the gist's revision, its parts and files, and its ETag. It lives in its own IndexedDB database, `fxm-sync` (`base-store.ts`), never in backups. Turning sync off keeps it, so turning sync back on with the same gist still knows what was deleted meanwhile.

## Merge rules

`merge.ts` is a three-way merge: besides the two libraries it compares both with the base.

- A change on one side only wins, and so does a deletion on one side only: a deleted playlist or an unliked song doesn't come back.
- When both sides changed the same record, the **backup import's rules** decide: likes, follows and plays here stay; the most recently saved track metadata wins; a pin wins, then the newer decision.
- **Playlists changed on both sides** are combined when the changes don't collide: songs added on either side, each where it was added; a song removed on one side; a rename on one side and a reorder on the other. When they collide (two different renames, two different reorders), **both versions are kept**: this device's stays, and the other side's becomes a copy named "… (other version)". Liked songs never collides: the newer order leads.
- A playlist **deleted on one side and changed on the other** is kept, and the device that kept it shows a notice with "Delete it".
- **The first sync** on a device, without a base, is the backup import's merge: everything in either library stays (plus the copies when a playlist differs). A setting still at its default takes the synced value.
- **Lineage.** Each push has a random revision ID and lists the revisions it was merged from (at most 1,000). Deletions on the gist's side count only when the gist descends from this device's base. If another device overwrote a push (a race the pre-push check can't fully close: GitHub supports no conditional writes for gists), or the gist was rewritten, what it lacks is kept and pushed back. Nothing is lost; at worst a deletion comes back.
- Near the start of the 90-day window (7 days), a play the gist lacks is never taken for a deletion: the device that wrote the gist may have cut its window a little later.

**Conflicts are visible on every device.** A copy's ID is the original's plus a hash of the version it keeps (`conflictCopyOf`), so the copy syncs like any playlist, a retried sync never makes a second one, and Settings finds every pair (`listConflicts`). The choices (`settleConflict`) are plain library edits that sync like others:

- **Keep "…"**: delete the copy.
- **Keep the other version**: the playlist takes the copy's name, description and songs, and the copy goes.
- **Keep both**: the copy becomes a playlist of its own, with a new ID in its place.

## The gist

`gist-format.ts`:

- **`fxm-library-sync.json`**, the manifest: format and version, the app and schema that wrote it, the revision and its ancestors, the app settings, and every part with its table, row count, size and hash. A device refuses a gist from a newer format, schema or backup version (`too-new`): it could damage data it doesn't understand.
- **Parts**, `fxm-<table>-<label>-<hash>.json`: the rows of one table, as canonical JSON. GitHub returns at most 1 MB of each file, so parts stay under 900 KB: rows are spread over hash buckets of about 64 KB that double as a table grows (a change rewrites one small part), and plays are cut into runs of whole days, the newest day in a part of its own.
- **Content-addressed names.** A push uploads only parts whose content changed and never rewrites a part in place, so a reader always finds what its manifest lists, even while a large push goes up in several requests (manifest last, a second apart). A push deletes only parts that neither its manifest nor the one it replaced lists, so two racing pushes each still find their parts. That keeps at most two generations: up to 140 parts each, within the 300 files GitHub lists.
- **Hashes** are checked on read. A gist changed outside FXM can't be read (`corrupt`); Settings offers to rewrite it from this device, as a new lineage, so other devices merge into it instead of taking what it lacks for deletions.

## Automatic sync

`scheduler.ts`, `auto-sync.ts` and `agent.tsx`. The agent sits in the app layout and loads the rest only while sync is on, so the first load of the app doesn't carry it.

| When | What |
|---|---|
| The app starts | Sync |
| The user comes back (focus, visible), the device is back online, every 15 minutes while visible | Sync, at most once a minute. These pull; new plays alone wait for a push |
| Playlists, likes, follows or settings change | Sync 5 s after the last change, at most 30 s after the first |
| Plays, track metadata or pins change | Sync after 10 quiet minutes, at most an hour after the first |
| A failure | Retry after 30 s, doubling up to 30 minutes, or when GitHub's `Retry-After` or rate-limit reset says |
| A failure only the user can fix (a revoked token, a deleted or foreign gist, a newer format, a damaged gist, a library too large) | Stop until the user acts; Settings says what to do |

One sync runs at a time across tabs (Web Locks; a lock within the tab where they are missing). Automatic syncs skip one another tab is running; Sync now waits for it. When a sync keeps two versions of a playlist or a deleted one, a toast says so, with a link to Settings.

## Privacy

- **Secret gists** aren't listed or searchable, but anyone with the link can open one, and the gist holds playlists, likes, follows, recent plays and settings. The setup dialog says so; the site's privacy page names GitHub.
- Requests go only to `api.github.com`, with the token as `Authorization: Bearer …`, `credentials: 'omit'`, `cache: 'no-store'` and no referrer. Errors never contain the token.
- The web app's content security policy must allow `https://api.github.com` in `connect-src` (stage 2.8's service list). The desktop app's policy allows `https:` already.

## Files

| File | What it holds |
|---|---|
| `github.ts` | The REST client over an injected `fetch`, its errors, token and gist-link helpers, the token form's link |
| `snapshot.ts` | What sync carries, cleaned with the backup's guards; the history window, the used tracks |
| `merge.ts` | The three-way merge and conflict copies |
| `gist-format.ts` | The manifest and parts: encoding, size limits, checks |
| `library-io.ts` | Reading the library and writing a merge in one transaction; settling conflicts |
| `base-store.ts` | The bases, in IndexedDB |
| `engine.ts` | One sync, creating and rewriting a gist, finding one |
| `sync-store.ts` | What the device remembers: token, gist, status, notices |
| `controller.ts` | The app's wiring: environment, locks, setup, sync now, conflicts, turning off |
| `scheduler.ts`, `auto-sync.ts`, `agent.tsx` | Automatic sync and its toast |
| `sync-settings.tsx`, `connect-dialog.tsx`, `messages.ts` | Settings › Sync, the setup and token dialogs, the words |
| `testing/` | A fake GitHub and snapshot builders, for tests only |
| `CLEAN-ROOM.md` | GitHub's API facts this code relies on, with sources and dates |

## Tests

```sh
scripts/run.sh pnpm vitest run apps/web/src/features/sync
```

They run offline against `testing/fake-github.ts`, which answers like the real API (status codes, error bodies, ETags and 304, scopes, pagination, truncation) and can simulate failures and races: two simulated devices sync through it in `engine.test.ts`. The live test needs a token of a test account with the Gists permission; it creates one secret gist and deletes it:

```sh
FXM_LIVE=1 FXM_GITHUB_TOKEN=github_pat_… scripts/run.sh pnpm vitest run apps/web/src/features/sync/live.test.ts
```

Keep the token in `.env.local` (gitignored) or your shell, never in git.
