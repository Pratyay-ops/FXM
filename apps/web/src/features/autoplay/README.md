# Autoplay (stage 3.4)

Endless autoplay radio: when the queue runs low, FXM adds songs like the ones the user just played, so the music keeps going for as long as they like what comes. The songs are picked on this device by the radio of the recommendation engine in `@fxm/core` ([its README](../../../../../packages/core/src/recommend/README.md#endless-radio-stage-34)); nothing leaves the device but the recommendation sources' own requests.

## What the user gets

- **On by default.** A switch in Settings → Playback, and one under Next up in the queue (Now playing → Queue), where the songs it adds show. The queue's shows only where autoplay can run; elsewhere Settings says why it adds nothing (see Tiers).
- **When.** Once fewer than 3 songs remain after the one playing, with repeat off, FXM adds 4 songs like the last 5 plays of the listening session. It waits a moment (1.5 s) for the queue to settle, so skipping through or editing the queue plans once, and it goes on each time the queue runs low. Meanwhile the queue says "Finding songs like the ones you just played…" below Next up, or in place of "Nothing up next" when nothing is left.
- **The user's songs first.** "Add to queue" puts a song before the songs autoplay added that wait at the end of the queue, so it plays before them, as in other players; autoplay's next batch goes after it. "Play next" works as ever.
- **Marked and removable.** The songs it adds say "Autoplay" in the queue, and so does the song playing when autoplay added it, whose Next up then says "Playing from Autoplay". Each can be removed like any song, and a song the user removed doesn't come back this session. Clearing Next up removes them all, and they don't come back either: autoplay finds others, and says so. A song the user moves is theirs: it loses its mark.
- **Likes and skips steer it.** A song the user skips (before half of it played) stops seeding the radio, however much they like it, and pulls its artist down; a song or artist they mostly skip never comes; a liked song weighs more and lifts its artist. The history and the affinity (stage 3.1) are read afresh for every batch.
- **No repeats** of the last 50 plays, nor of anything in the queue.
- **Switching it off** stops adding, and takes the songs autoplay added that haven't played out of the queue, except the ones the user moved; Settings says so. Switching it on fills a queue that is low.
- **Screen readers** hear, while the queue shows, what autoplay added ("Autoplay added 4 songs, starting with …") and what switching it off took out.
- **History and scrobbling.** A play of a song autoplay added is recorded as a play of its radio (`{ type: 'radio', seed, title: 'Autoplay' }`), seeded with the play it grew from, so scrobbles of it say the user didn't choose it (stage 8.2).
- **A queue that ends while songs are on their way** (a slow connection, say) plays on with them once they arrive. A queue that ended before autoplay was switched on just gets them: the user presses play.

### Tiers

| | Free only | Lite | Full |
|---|---|---|---|
| Autoplay | — (Settings says it needs YouTube Music, and how this device reaches it with what is out, `reachSentence` from `features/connect/explain.ts`, with a link to the tiers and install guides; the queue shows no switch) | ✅ YouTube Music radio | ✅ also Spotify's radio, when Spotify is on |

Like Home's recommendations, autoplay runs only where YouTube Music is reachable (`canRecommend`), whose songs are what plays. Songs only Spotify suggests are left out: they play only through a match, which the queue skips until the user reviews it. Spotify's radio still raises the songs YouTube Music suggests too. Settings starts from the check the queue's switch makes (`canRecommend`, in `autoplayNote`), so the two never disagree: it says what autoplay needs in the Free tier once the tier is known, so the note doesn't come and go. That is after FXM Connect had its chance to answer (the registry's `detecting`) and, in the app, after the first Lite self-test too (Home's sources say `detecting` until then, `homeSourcesUntil`), and only once the recommendation sources are wired in, which the app does as soon as the platform is ready (see Wiring).

## How it works

| File | What |
|---|---|
| `autoplay.ts` | `connectAutoplay(player)`: watches the queue, decides when to extend it, adds and marks the songs, keeps them behind the songs the user adds, drops a plan whose queue changed meanwhile, remembers what the user removed, withdraws its songs when switched off, and says what it is doing. In the app's first chunk, so it loads nothing heavy itself |
| `extend.ts` | One extension, loaded on first use: the taste from the library, the seeds, one radio fetch, the batch |
| `autoplay-marks.ts` | Which queue items autoplay added (by uid, with the track each held), saved next to the queue, and the radio context of their plays. `adopt` unmarks a song the user moved |
| `autoplay-activity.ts` | What autoplay is doing (`idle`, `waiting`, `planning`) and what it last changed, for the queue panel; not saved |
| `autoplay-store.ts` | The setting |
| `autoplay-setting.tsx` | The Settings row and its note, the queue's switch, the "Autoplay" mark and the "Finding songs…" line |

**One extension** (`planExtension`):

1. **The taste:** the top of the affinity and the 100 latest distinct plays (`RADIO_PROFILE_LIMITS`), with the onboarding picks, through Home's `loadTasteProfile`.
2. **The seeds:** `planRadioSeeds`, with the track playing now as the newest play.
3. **One radio fetch** (`nextRadioSeed`): the heaviest seed whose radio isn't cached, through the recommendation sources (stage 3.2's collector, `parts: ['radio']`) with a context at the request budget's `prefetch` priority (stage 1.2), as the player asks for what plays next. The collector gets 8 s (`EXTENSION_DEADLINE_MS`) and is cut off a little later if it doesn't keep it; the batch is built from what arrived. Collections go into Home's cache (`collectionsOf`, 30 minutes), keyed as Home keys them (`collectionKey`), so a recent play's radio is fetched once for autoplay and Home's "Because you listened" alike; a collection a source failed or was late in isn't kept. Each is marked as Home marks its own when YouTube Music's radio skipped the seed (`skipsRadio`: a track of another source without a sure match of its own song), so a Home build that reuses one doesn't keep its lists for their period.
4. **The batch:** `buildRadioBatch` over the radios of every seed at hand, with the affinity of everything they suggest (`completeProfile`), leaving out the queue and the songs the user removed.

**Situations.** Autoplay plans a state of the queue (what plays, what follows, the mode). One whose plan found nothing (or failed) is tried again only when the queue moves on, the setting or the services (or what they reach) change, or the queue ends. A plan that added songs leaves nothing blocked, so a queue the user empties again refills.

**Marks.** A queue item keeps its uid through edits, shuffles, mode switches and reloads, so a mark follows its item; a mark whose uid holds another track marks nothing, and marks of items that left the queue are dropped. The queue panel unmarks a song the user moves (`adopt`): it is a song they chose now, so switching autoplay off leaves it, and a play of it counts as one of the queue's.

**The user's songs first.** When an append by anyone but autoplay (the app's "Add to queue", the local files' rows) lands behind a run of autoplay's songs at the end of the queue, `connectAutoplay` moves the appended items before that run with `player.move`, once every listener has seen the append (a microtask later); whichever side is shorter moves. Moves keep every uid, so the marks stay. Songs the user placed after autoplay's themselves stay there: only the items just appended move.

**Activity.** `autoplay-activity.ts` holds `waiting` while the queue settles, `planning` while songs are on their way, and `idle` otherwise, and a new `change` for every batch it adds and every withdrawal. The queue panel shows the "Finding songs…" line while it isn't idle, and tells screen readers each change through its live region, only while it shows.

## Wiring

Autoplay reaches the recommendation sources through Home's seam, `appHomeServices` (`features/home/services.tsx`), which the app's composition root sets (stage 2.9b, `app/services/home.ts`, [its README](../../app/services/README.md)): `sources` at once, the sources registry (2.4's `appSources`, 1.2's platform inside), saying `detecting` until the platform's first detection has ended, and `recommendations` once the platform is ready, 3.2's collector over the app's providers. Its `context` passes the radio's `prefetch` priority on to the platform, and its `collect` the radio's `deadlineMs` to the collector, which then answers by the deadline with what its sources found. Until the recommendations are wired in, autoplay does nothing, as in the Free tier. The app's playback (`features/now-playing/playback.ts`), whose player the composition root plays through (the desktop app's too, `app/services/desktop.ts`), connects autoplay to it and gives the play recorder `autoplayContextOf`.

## Storage

| Key | What |
|---|---|
| `fxm.autoplay.v1` | The setting (`{ enabled }`), followed across tabs |
| `fxm.autoplay.queue.v1` | The marks, by uid: `{ trackId, seed }`, at most 1,000 |

Both are read back through sanitizers: anything malformed is dropped, and the setting stays on unless it says `false`.

## Tests

All offline. `autoplay.test.ts` drives a real player on the fake engine with fake timers: when it extends and when not (enough left, repeat, off, Free tier, nothing wired), settling, one plan per situation, plans dropped when the queue or the mode changes or autoplay goes off, playing on after the queue ended, switching off and on, songs the user moved, the user's songs before autoplay's, what it reports doing, removed songs, a new queue, refilling, restored marks, the services and what they reach, failures and disconnecting. `extend.test.ts` plans against the real library (fake IndexedDB) and Home's fake collector: one fetch per extension at `prefetch`, blending kept radios, Home's cache, the queue and removed songs, skips the library recorded, a favourite skipped just now, music videos in Music mode, failed and late sources, the mark of a radio YouTube Music skipped, cancellation, the tiers, and the app's library and picks. `autoplay-store.test.ts` covers the stores, adoption, the activity's messages and the play context. `autoplay-app.test.tsx` runs it in the app: the queue panel's marks, switch, "Finding songs…" line and announcements, "Add to queue" after a batch, Clear, a moved song kept when switched off, the song playing and "Playing from Autoplay", a play recorded as a radio play, the queue in the Free tier, and Settings in every tier, wired in or not, while FXM Connect answers and until the app knows the tier (`homeSourcesUntil`), with the Free tier's note on a computer, a Mac's Safari and an iPhone. The composition root's `app/services/home.test.ts` plans an extension on the app's own Home services in the Lite tier (one recorded YouTube Music radio, asked at `prefetch`), and checks that they hand the radio's deadline to the collector. A live check in the composed app, `scripts/build-dist/e2e/radio.e2e.ts` (`FXM_LIVE=1` only), is below.

## Checked live

Autoplay kept a queue going in the Lite tier of the composed app on 2026-10-26: `make dist`'s build, served the way Cloudflare Pages would, in headless Chromium without FXM Connect, muted. It added four songs after the last song of a search's results, marked "Autoplay", and the first of them played, from its radio, within 15 YouTube requests. So the site's `AVAILABLE.radio` (`apps/site/src/config.ts`) is on. The check is `scripts/build-dist/e2e/radio.e2e.ts` (`FXM_LIVE=1` only); [the deploy README](../../../../../scripts/build-dist/README.md#autoplay-in-the-lite-tier) says how to run it again.

## Pending

- **The develop preview:** run the live check against it once 3.4 is merged, and against production after the release that ships it.
