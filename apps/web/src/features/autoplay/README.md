# Autoplay (stage 3.4)

Endless autoplay radio: when the queue runs low, FXM adds songs like the ones the user just played, so the music keeps going for as long as they like what comes. The songs are picked on this device by the radio of the recommendation engine in `@fxm/core` ([its README](../../../../../packages/core/src/recommend/README.md#endless-radio-stage-34)); nothing leaves the device but the recommendation sources' own requests.

## What the user gets

- **On by default.** A switch in Settings → Playback, and one under Next up in the queue (Now playing → Queue), where the songs it adds show. The queue's shows only where autoplay can run; Settings says what it needs elsewhere.
- **When.** Once fewer than 3 songs remain after the one playing, with repeat off, FXM adds 4 songs like the last 5 plays of the listening session. It waits a moment (1.5 s) for the queue to settle, so skipping through or editing the queue plans once, and it goes on each time the queue runs low.
- **Marked and removable.** The songs it adds say "Autoplay" in the queue, and so does the song playing when autoplay added it. Each can be removed like any song, and a song the user removed doesn't come back this session. Clearing Next up removes them all; autoplay then adds others.
- **Likes and skips steer it.** A song the user skips stops seeding the radio and pulls its artist down; a song or artist they mostly skip never comes; a liked song weighs more and lifts its artist. The affinity (stage 3.1) is read afresh for every batch.
- **No repeats** of the last 50 plays, nor of anything in the queue.
- **Switching it off** stops adding, and takes the songs autoplay added that haven't played out of the queue. Switching it on fills a queue that is low.
- **History and scrobbling.** A play of a song autoplay added is recorded as a play of its radio (`{ type: 'radio', seed, title: 'Autoplay' }`), seeded with the play it grew from, so scrobbles of it say the user didn't choose it (stage 8.2).
- **A queue that ends while songs are on their way** (a slow connection, say) plays on with them once they arrive. A queue that ended before autoplay was switched on just gets them: the user presses play.

### Tiers

| | Free only | Lite | Full |
|---|---|---|---|
| Autoplay | — (Settings says it needs YouTube Music, and how to get it; the queue shows no switch) | ✅ YouTube Music radio | ✅ also Spotify's radio, when Spotify is on |

Like Home's recommendations, autoplay runs only where YouTube Music is reachable (`canRecommend`), whose songs are what plays. Songs only Spotify suggests are left out: they play only through a match, which the queue skips until the user reviews it. Spotify's radio still raises the songs YouTube Music suggests too.

## How it works

| File | What |
|---|---|
| `autoplay.ts` | `connectAutoplay(player)`: watches the queue, decides when to extend it, adds and marks the songs, drops a plan whose queue changed meanwhile, remembers what the user removed, and withdraws its songs when switched off. In the app's first chunk, so it loads nothing heavy itself |
| `extend.ts` | One extension, loaded on first use: the taste from the library, the seeds, one radio fetch, the batch |
| `autoplay-marks.ts` | Which queue items autoplay added (by uid, with the track each held), saved next to the queue, and the radio context of their plays |
| `autoplay-store.ts` | The setting |
| `autoplay-setting.tsx` | The Settings row, the queue's switch and the "Autoplay" mark |

**One extension** (`planExtension`):

1. **The taste:** the top of the affinity and the 100 latest distinct plays (`RADIO_PROFILE_LIMITS`), with the onboarding picks, through Home's `loadTasteProfile`.
2. **The seeds:** `planRadioSeeds`, with the track playing now as the newest play.
3. **One radio fetch** (`nextRadioSeed`): the heaviest seed whose radio isn't cached, through the recommendation sources (stage 3.2's collector, `parts: ['radio']`) with a context at the request budget's `prefetch` priority (stage 1.2), as the player asks for what plays next. The collector gets 8 s (`EXTENSION_DEADLINE_MS`) and is cut off a little later if it doesn't keep it; the batch is built from what arrived. Collections go into Home's cache (`collectionsOf`, 30 minutes), keyed as Home keys them (`collectionKey`), so a recent play's radio is fetched once for autoplay and Home's "Because you listened" alike; a collection a source failed or was late in isn't kept.
4. **The batch:** `buildRadioBatch` over the radios of every seed at hand, with the affinity of everything they suggest (`completeProfile`), leaving out the queue and the songs the user removed.

**Situations.** Autoplay plans a state of the queue (what plays, what follows, the mode). One whose plan found nothing (or failed) is tried again only when the queue moves on, the setting or the services (or what they reach) change, or the queue ends. A plan that added songs leaves nothing blocked, so a queue the user empties again refills.

**Marks.** A queue item keeps its uid through edits, shuffles, mode switches and reloads, so a mark follows its item; a mark whose uid holds another track marks nothing, and marks of items that left the queue are dropped.

## Wiring

Autoplay reaches the recommendation sources through Home's seam, `appHomeServices` (`features/home/services.tsx`): once Home's `sources` (2.4's `appSources`, 1.2's platform inside) and `recommendations` (3.2's collector) are wired in, autoplay works too, with nothing more to wire. The app's composition root (stage 2.9, `app/services`) lists that seam as still open; until it is wired, autoplay does nothing, as in the Free tier. The app's playback (`features/now-playing/playback.ts`), whose player the composition root plays through, connects autoplay to it and gives the play recorder `autoplayContextOf`.

## Storage

| Key | What |
|---|---|
| `fxm.autoplay.v1` | The setting (`{ enabled }`), followed across tabs |
| `fxm.autoplay.queue.v1` | The marks, by uid: `{ trackId, seed }`, at most 1,000 |

Both are read back through sanitizers: anything malformed is dropped, and the setting stays on unless it says `false`.

## Tests

All offline. `autoplay.test.ts` drives a real player on the fake engine with fake timers: when it extends and when not (enough left, repeat, off, Free tier, nothing wired), settling, one plan per situation, plans dropped when the queue or the mode changes or autoplay goes off, playing on after the queue ended, switching off and on, removed songs, a new queue, refilling, restored marks, the services and what they reach, failures and disconnecting. `extend.test.ts` plans against the real library (fake IndexedDB) and Home's fake collector: one fetch per extension at `prefetch`, blending kept radios, Home's cache, the queue and removed songs, skips the library recorded, failed and late sources, cancellation, the tiers, and the app's library and picks. `autoplay-store.test.ts` covers both stores and the play context. `autoplay-app.test.tsx` runs it in the app: the queue panel's marks and switch, the song playing, a play recorded as a radio play, and the queue and Settings in the Free and Full tiers.

## Pending

- **Wiring:** Home's services, which autoplay shares (see Wiring): the 3.3 row of the composition root's open seams (`app/services/README.md`).
- **The site:** `AVAILABLE.homeFeed` and `AVAILABLE.radio` (`apps/site/src/config.ts`) name stages 3.3 and 3.4. Turn them on, and review the copy that reads them, once Home's recommendation sources are wired into the deployed app.
