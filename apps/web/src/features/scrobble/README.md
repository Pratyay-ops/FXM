# Scrobbling in the web app

Stage 8.2: the songs the user plays go to their own ListenBrainz or Last.fm profile, once they connect an account in **Settings → Scrobbling**. The scrobbler, the clients and the rules are [`@fxm/sources/scrobble`](../../../../../packages/sources/src/scrobble/README.md); this folder connects them to the app.

| File | What it holds |
|---|---|
| `start-scrobbling.ts` | `startScrobbling()`, which `main.tsx` runs once: it listens to the player's plays, and loads and runs the rest once an account is connected |
| `scrobbling.ts` | The app's scrobbler: its targets from the connected accounts, its queue, what it does with plays, the `online` event and the Web Lock |
| `scrobbling-store.ts` | The connected accounts (zustand, `localStorage` key `fxm.scrobbling.v1`) |
| `scrobble-db.ts` | The queue: the IndexedDB database `fxm-scrobble` |
| `scrobbling-settings.tsx` | The Settings section |

## Opt-in

Nothing is sent, nothing is loaded and the queue's database isn't opened until the user connects an account. The app's first chunk holds only `start-scrobbling.ts`, `play-events.ts` and the accounts store (2.9 KB, 1.1 KB gzipped, measured on 2026-10-26); the scrobbler and the clients are a chunk of their own (24 KB, 9 KB gzipped), loaded with Dexie, which the library shares, once an account exists, at start or when Settings opens. Plays that end while it loads wait for it, in order. Each service is connected on its own:

- **ListenBrainz:** the user pastes the user token from their ListenBrainz settings; FXM checks it (`validate-token`) and shows whose it is. ListenBrainz profiles are public, and the section says so.
- **Last.fm:** FXM ships no Last.fm key or secret. The user creates an API account of their own and enters its key and shared secret. **Connect** gets a request token, **Open Last.fm** opens the page where the user allows it (in a new tab), and coming back to FXM's tab finishes by itself (**Done** does the same). The session key that Last.fm then gives doesn't expire. Last.fm profiles are public too, and the section says so.

The token and the shared secret go in text fields that show dots until the user shows them, not in password fields: browsers offer to save what a password field held once its form is done, and to sync it to the user's account, while these must stay on the device. The fields also carry the markers password managers read to leave a field alone (`autocomplete="off"`, `data-1p-ignore`, `data-lpignore`, `data-bwignore`). Not yet checked in a headed browser: that connecting shows no save prompt in Chrome and Firefox.

**Disconnect** forgets the account and drops what its queue still holds. For Last.fm, the section links to the page where the user can also end the session at Last.fm.

## Where things live

- **Accounts:** `localStorage`, under a key of their own that library backups don't read, so a backup file never carries a token, a key or a secret. Other tabs follow changes through the `storage` event. Like any site data, anyone who can use this browser profile can read them.
- **The queue:** the IndexedDB database `fxm-scrobble`, apart from the library's `fxm`: the library's schema never changes for it, and backups never carry it. It survives restarts, as Last.fm asks of a scrobble cache. One record per scrobble and service, in an auto-incremented order, indexed by `[service+id]`.

## How plays arrive

The play recorder of stage 3.1 (`features/signals/play-recorder.ts`), which the app's player connects where it is created (`features/now-playing/playback.ts`), announces each play as it starts and each play it records as it ends, through `features/signals/play-events.ts`. `startScrobbling` listens there and hands them to the scrobbler (`playListenerFor`):

- a start sends "now playing" after 3 seconds;
- a recorded play is queued for each service whose rules it meets (half the track or 4 minutes heard; on Last.fm, a track longer than 30 seconds), then the queues are sent. A play from a radio tells Last.fm the user didn't choose it.

A listening history imported from another service (stage 3.6) goes straight to the library, so it is never scrobbled. Neither is a play that a page killed in the background cut short: the recorder's checkpoints put it in the library on the next start, but announce nothing, since that page announced the plays it finished.

## Sending

- **Every tab** queues its own player's plays into the one shared queue. Each flush runs under the Web Lock `fxm-scrobble-flush`, so the tabs take turns and no scrobble goes out twice. Where Web Locks are missing (insecure contexts), each tab flushes on its own.
- **Offline:** plays keep queueing, and the queue is sent when the browser fires `online`, and on the next start.
- **Refusals:** when a service refuses the account (a revoked token or session, a changed secret), the account is marked refused. Its plays keep queueing, and the section asks the user for a new token, or to connect Last.fm again: with the key and secret FXM has, or with new ones (**Enter another key**, which the section also shows when Last.fm refuses the stored ones). Once the same user is connected again, the queue is sent. A refusal only marks the account whose credential was refused, so a tab that sent with an old token never pauses the new one another tab connected.
- **Another user:** each scrobble is queued for the user connected to its service (their name there), and the scrobbler only ever sends it to that user. So no play of one person reaches another's profile, even a play that ended while the first was disconnecting, in this tab or another. Connecting to a service also drops what its queue held, unless the same user connects again, and every tab empties the queue of a service whose account is gone, at start and as soon as it goes.
- **Storage:** when the device can't save a scrobble (storage full, or blocked in the browser's settings), it waits in memory and is still sent, and the section says that the ones not yet sent are lost when FXM closes.

The section shows, per service, whether it is on and as whom, and what waits to be sent, with the time of the next try after a failure.

Requests go straight from the browser to `api.listenbrainz.org` and `ws.audioscrobbler.com`, which answer any origin, so every tier scrobbles. They use the browser's `fetch` with `credentials: 'omit'` and `redirect: 'error'`. Where the app has the platform layer (`@fxm/platform`), `scrobbleContext()` should come from the platform's context, so scrobbles pass its host table, which lists both hosts, and use the desktop and Android transports like every other request. The deployed app's CSP must allow both in `connect-src`; the site's privacy page names both services, what each listen carries, and that both profiles are public.

## Tests

- `scrobbling.test.ts`: a real player, the play recorder and the scrobbler against fake services: now playing and scrobbles for a song heard to the end, nothing for quick skips, imports or without an account, refusals and reconnecting, offline and `online`, leftovers from an earlier session, a play that ends during a Disconnect never reaching the next account, queues of services without an account emptied, a store that can't save, and the Web Lock.
- `start-scrobbling.test.ts`: nothing loads without an account; it loads once one is connected, at start or later, plays wait for it in order, and a failed load is tried again.
- `scrobbling-settings.test.tsx`: the section in the rendered app: both flows, every error, pending scrobbles, disconnecting (also when the queue can't be emptied), accounts that were refused (also with a new Last.fm key and secret), the fields that aren't password fields, and a device that can't save scrobbles.
- `scrobble-db.test.ts` and `scrobbling-store.test.ts`: the queue on IndexedDB (fake-indexeddb), and the accounts in storage.
