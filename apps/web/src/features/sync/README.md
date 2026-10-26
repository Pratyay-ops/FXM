# Sync with GitHub

Optional sync of the library and settings between a person's devices (stage 8.4). FXM has no servers, so the copy lives in **one secret gist on the user's own GitHub account**, written with a token the user creates. Sync is off until the user sets it up in **Settings › Sync**.

## Setting it up

1. **A token.** The dialog links to GitHub's form for a new fine-grained token, already filled in: named "FXM library sync", with only the **Gists** permission (Read and write), expiring in 90 days (`NEW_TOKEN_URL` in `github.ts`). The user pastes the token.
   - FXM checks it with `GET /user`. A classic token that can do more than `gist` (its `X-OAuth-Scopes`) is refused: FXM holds no token with more power than sync needs.
   - The token stays on the device, in `localStorage` (`fxm.sync.v1`, see `sync-store.ts`). It never goes into the library database, a backup or the gist, and FXM sends it only to `api.github.com`. Turning sync off forgets it; the dialog links to GitHub's list of tokens, because the token itself stays valid until it expires.
   - A fine-grained token can read and change **all** of the user's gists: GitHub has no per-gist permission. The dialog says what the gist holds.
2. **The gist.** FXM lists the account's gists for a secret one with the manifest file `fxm-library-sync.json` (`findSyncGists`); public ones are left out. GitHub doesn't document whether a fine-grained token lists secret gists, so the user can also paste the gist's link, which Settings shows (with Copy link) on any device that syncs.
3. **Confirmation.** Before anything changes, the dialog shows what the gist and this device hold, and whose account the gist is on: "Continue only if @login is your own GitHub account", with the account on the button too. Joining is always a first sync, whatever the device remembers of the gist (`confirmConnect` drops its base): it merges the two and removes nothing. Creating makes a secret gist with this device's library. A sync gist changed outside FXM can be rewritten from the device; one saved by a newer FXM needs an update first. Sync is saved as on only after that first sync worked.

## What syncs

Records are the library backup's (`db/backup.ts`), and every one goes through the backup's guards (`db/validate.ts`) on the way in and out (`snapshot.ts`).

| Carried | Stays on each device |
|---|---|
| Playlists and their custom order, Liked songs and its order, the order of the playlists list | **Downloads**: it lists files stored on this device only |
| Likes, follows | Undo orders: Undo applies to this device's last shuffle or saved sort |
| Reserved settings whose key starts with `sync.` | Every other reserved setting: credentials, secret sources, network endpoints and per-device privacy switches must never use `sync.` |
| Plays of the last 90 days | Older plays: sync never reads, sends or deletes them. The query of a search a play started from |
| Pins ("Not the right version?") | The matching engine's own decisions: a cache each device rebuilds |
| The track metadata the above use | The rest of the track cache |
| App settings: catalog mode and theme | Import progress: an import resumes on the device that runs it |

The app settings (`appSettingsIO` in `controller.ts`) and the `sync.` settings apply on every device, from a gist anyone with its link can read. Only settings that should be the same everywhere belong there: never a credential, a secret source, a network endpoint, or a per-device switch such as turning a service off on one device.

GitHub sends the whole gist back after every update (the API returns gist objects with up to 1 MB of each file), so the gist carries what other devices need and no more. Settings shows how large it is. A sync reads only what it carries (`readLibrarySnapshot`): the plays of the window through their index, the pins, and the tracks the rest uses.

## How a sync works

`engine.ts`, `syncLibrary`:

1. **Read.** A conditional read with the gist's ETag; GitHub answers 304 when nothing changed, which doesn't count against its rate limit. A gist that is public, or belongs to another account, stops sync (`public`, `not-owner`).
2. **Merge** the gist into the library, in **one transaction** that reads this device's library and writes only what changed (`library-io.ts`). A like made in another tab meanwhile waits for the transaction and is carried by the next sync, never overwritten. If the merge would remove a lot here (more than one playlist with songs, or more than a tenth of the likes, follows or plays; `exceedsRemovalLimits` in `merge.ts`), it stops before writing anything (`removals`), and Settings asks: **Remove them here too**, or **Keep them**, which puts them back in the gist, so the other devices get them back too.
3. **Push**, when the gist lacks part of the merged library: only parts whose content changed, and a new manifest, as one revision. Right before, a conditional read checks the gist is still the one this round merged; if another device pushed meanwhile, the round merges again. Every answer GitHub sends is checked: a gist that turned public stops the push.
4. **Save the base**: the library both sides agreed on, with the gist's revision, its parts and files, and its ETag. It lives in its own IndexedDB database, `fxm-sync` (`base-store.ts`), never in backups, and only while sync is on: turning sync off deletes it. A base that can't be read (damaged, or of another version) is dropped, and the next sync is a first sync.

## Merge rules

`merge.ts` is a three-way merge: besides the two libraries it compares both with the base.

- A change on one side only wins, and so does a deletion on one side only: a deleted playlist or an unliked song doesn't come back.
- When both sides changed the same record, the **backup import's rules** (`db/merge.ts`) decide: likes, follows and plays here stay; the most recently saved track metadata wins; a pin wins, then the newer decision.
- **Playlists changed on both sides** are combined when the changes don't collide: songs added on either side, each where it was added; a song removed on one side; a rename on one side and a reorder on the other. When they collide (two different renames, two different reorders), **both versions are kept**: this device's stays, and the other side's becomes a copy named "… (other version)". Liked songs never collides: the newer order leads.
- A playlist **deleted on one side and changed on the other** is kept, and the device that kept it shows a notice with "Delete it". Only its content counts as a change: saving it unchanged, which moves only its `updatedAt`, doesn't.
- **The first sync** on a device, without a base, is the backup import's merge: everything in either library stays (plus the copies when a playlist differs). A setting still at its default takes the synced value.
- **Lineage.** Each push has a random revision ID and lists the revisions it was merged from (at most 1,000). Deletions on the gist's side count only when the gist descends from this device's base. If another device overwrote a push (a race the pre-push check can't fully close: GitHub supports no conditional writes for gists), or the gist was rewritten, what it lacks is kept and pushed back. Nothing is lost; at worst a deletion comes back. A gist older than the base is GitHub serving an old read for up to 10 minutes after this device's push (`STALE_READ_GRACE_MS`); after that, its history really went back, and it is merged the same way.
- **Plays.** The manifest says where its writer's 90-day window started (`historySince`). A play the gist lacks counts as deleted only if it started after that: older ones fell out of the writer's window. So clearing the history on one device clears the synced plays on the others, near the start of the window too, while a device whose clock runs ahead never deletes plays it merely cut off. A gist without `historySince` gets a 7-day margin instead.

**Conflicts are visible on every device.** A copy's ID is the original's plus a hash of the version it keeps (`conflictCopyOf`), so the copy syncs like any playlist, a retried sync never makes a second one, and Settings finds every pair (`listConflicts`). The choices (`settleConflict`) are plain library edits that sync like others:

- **Keep "…"**: delete the copy.
- **Keep the other version**: the playlist takes the copy's name, description and songs, and the copy goes.
- **Keep both**: the copy becomes a playlist of its own, with a new ID in its place.

## The gist

`gist-format.ts`:

- **`fxm-library-sync.json`**, the manifest: format and version, the app and schema that wrote it, the revision and its ancestors, the start of the writer's history window, the app settings, every part with its table, row count, size and hash, and the parts of the manifest it replaced that the gist still holds (`previous`). A device refuses a gist from a newer format, schema or backup version (`too-new`): it could damage data it doesn't understand.
- **Parts**, `fxm-<table>-<label>-<hash>.json`: the rows of one table, as canonical JSON. GitHub returns at most 1 MB of each file, so parts stay under 900 KB: rows are spread over hash buckets of about 64 KB that double as a table grows (a change rewrites one small part), and plays are cut into runs of whole days, the newest day in a part of its own. A playlist larger than 32 KB (a few hundred songs) goes in pieces: its record with its first songs and `pieces`, then rows `{ id, piece, trackIds, addedAt }`, joined again on the way in. So a playlist of any length syncs.
- **Content-addressed names.** A push never rewrites a part in place. It keeps the parts of the manifest it replaces one push longer, and uploads every other part of its own, even one the gist holds already, because only those are sure to stay while another device pushes too. So a reader always finds what its manifest lists, even while a large push goes up in several requests (manifest last, a second apart). A push deletes only what it knows is old: the parts of the manifest before (`previous`), and files no manifest lists once they have been there for an hour (`STRAY_AGE_MS`), such as what a failed push left behind. A file no manifest lists may be another device's push still going up, so it stays until then. That keeps about two generations: up to 140 parts each, within the 300 files GitHub lists.
- **Hashes** are checked on read. A gist changed outside FXM can't be read (`corrupt`); Settings offers to rewrite it from this device, as a new lineage, so other devices merge into it instead of taking what it lacks for deletions.

## Automatic sync

`scheduler.ts`, `auto-sync.ts` and `agent.tsx`. The agent sits in the app layout and loads the rest only while sync is on, so the first load of the app doesn't carry it.

| When | What |
|---|---|
| The app starts | Sync |
| The user comes back (focus, visible), the device is back online, every 15 minutes while visible | Sync, at most once a minute. These pull; new plays alone wait for a push |
| Playlists, likes, follows, reserved settings, the theme or the catalog mode change | Sync 5 s after the last change, at most 30 s after the first |
| Plays, track metadata or pins change | Sync after 10 quiet minutes, at most an hour after the first |
| A failure | Retry after 30 s, doubling up to 30 minutes, or when GitHub's `Retry-After` or rate-limit reset says, whether or not anything else asks for a sync |
| A failure only the user can fix (a revoked token, a deleted, public or foreign gist, a newer format, a damaged gist, a library too large, much removed by another device) | Stop until the user acts; a toast says so, and Settings says what to do |

One sync runs at a time across tabs (Web Locks; a lock within the tab where they are missing). Automatic syncs skip one another tab is running; Sync now waits for it. When a sync keeps two versions of a playlist or a deleted one, a toast says so, with a link to Settings. Every tab follows the others' sync settings: when one turns sync off or clears a problem, the others drop it too (`syncConfigAcrossTabs`).

## Privacy

- **Secret gists** aren't listed or searchable, but anyone with the link can open one. **GitHub keeps every earlier version** of a gist, and anyone with the link can read those too (its Revisions, or a `git clone`). So besides the playlists, likes, follows, plays of the last 90 days and settings it holds now, the gist holds every play synced since sync was turned on, and the playlists, likes and history removed since, with their dates. Removing something in FXM doesn't remove it from those versions: deleting the gist does, and **Turn off sync** offers to. The setup dialog, Settings (next to Copy link), the Clear history and Replace dialogs and the site's privacy page say so.
- **A gist made public** on GitHub can never be made secret again. Sync checks every read and write, and stops (`public`) rather than publish the library; setting up again creates a new secret gist.
- **What stays on the device:** search queries (a play's search context), reserved settings without the `sync.` prefix, and everything in the table above.
- **Someone else's token** would copy this library to their account and let them change it: the confirmation names the account and asks to continue only if it is the user's own.
- **Turning sync off** deletes the bases (`fxm-sync`), so nothing synced stays on the device where the user can't see it, and can delete the gist. The token stays valid on GitHub until it expires, so the dialog links to GitHub's list of tokens.
- Requests go only to `api.github.com`, with the token as `Authorization: Bearer …`, `credentials: 'omit'`, `cache: 'no-store'` and no referrer. Errors never contain the token.
- The web app's content security policy must allow `https://api.github.com` in `connect-src` (stage 2.8's service list). The desktop app's policy allows `https:` already.

## Files

| File | What it holds |
|---|---|
| `github.ts` | The REST client over an injected `fetch`, its errors, token and gist-link helpers, the token form's link |
| `snapshot.ts` | What sync carries, cleaned with the backup's guards; the history window, the used tracks, the `sync.` settings, private play contexts |
| `merge.ts` | The three-way merge, conflict copies, and how much a merge removes |
| `gist-format.ts` | The manifest and parts: encoding, size limits, long playlists in pieces, checks |
| `library-io.ts` | Reading the library and writing a merge in one transaction (the repository's `syncTransaction`); settling conflicts |
| `base-store.ts` | The bases, in IndexedDB, checked on the way in |
| `engine.ts` | One sync, creating, rewriting and deleting a gist, finding one |
| `sync-store.ts` | What the device remembers: token, gist, status, notices |
| `controller.ts` | The app's wiring: environment, locks, setup, sync now, conflicts, turning off |
| `scheduler.ts`, `auto-sync.ts`, `agent.tsx` | Automatic sync and its toasts |
| `sync-settings.tsx`, `connect-dialog.tsx`, `messages.ts` | Settings › Sync, the setup, token and turn-off dialogs, the words |
| `testing/` | A fake GitHub and snapshot builders, for tests only |
| `CLEAN-ROOM.md` | GitHub's API facts this code relies on, with sources and dates |

## Tests

```sh
scripts/run.sh pnpm vitest run apps/web/src/features/sync
```

They run offline against `testing/fake-github.ts`, which answers like the real API (status codes, error bodies, ETags and 304, scopes, pagination, truncation) and can simulate failures, races and a gist turned public: two simulated devices sync through it in `engine.test.ts`. The live test needs a token of a test account with the Gists permission; it creates one secret gist and deletes it:

```sh
FXM_LIVE=1 FXM_GITHUB_TOKEN=github_pat_… scripts/run.sh pnpm vitest run apps/web/src/features/sync/live.test.ts
```

Keep the token in `.env.local` (gitignored) or your shell, never in git.
