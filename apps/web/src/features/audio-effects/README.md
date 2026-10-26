# Audio effects (`features/audio-effects`)

Stage 8.1: the equalizer, loudness normalization, crossfade, playback speed and the sleep timer, in the web app (and the desktop and Android apps, which run it). The effects themselves are `@fxm/core`'s (`effects/`: bands, presets, curve, loudness gain) and `@fxm/player`'s (the player's crossfade and sleep timer, the engines' equalizer and levels); this folder holds the settings, the wiring and the UI. The player package's README has [how each effect works on each platform](../../../../../packages/player/README.md#audio-effects).

## What the user gets

- **Settings → Sound** (`effects-section.tsx`, anchor `#sound`):
  - **Equalizer:** a switch, and "Adjust the bands": a preset menu (Flat, Bass boost, Rock, Vocal… or Custom once a band moved), the curve the filters play, one slider per band (31 Hz to 16 kHz, −12 to +12 dB in half decibels) and "Reset to flat". Moving a band or picking a preset switches it on. When it can't process the track that plays, the row says why (`equalizerNote`): without FXM Connect (Lite, Free only) it can't read YouTube audio; in the desktop app not yet (stage 7.6); with FXM Connect only after a googlevideo redirect, until the next track.
  - **Normalize volume:** a switch (on by default), the level (Normal −14 LUFS, Quiet −18, Quietest −23) and track or album gain, with what it does to the track that plays ("This track plays 3.9 dB quieter").
  - **Crossfade:** 0 (off) to 12 s, and "Crossfade within albums" (off: albums stay gapless). Disabled where the engine has none (the Android app's native player).
  - **Playback speed:** 0.5× to 2×, pitch kept.
- **The Sound dialog** (`sound-dialog.tsx`, loaded on first use): the sleep timer (Off, 15, 30, 45 min, 1 h, 1 h 30 min, End of track, with the time left), the speed at a tap, the equalizer with its bands, volume normalization, and "More in Settings". The app layout renders it once; it opens from the **player bar's Sound button** (sliders, or a moon while a sleep timer runs; highlighted while something differs from normal, with the speed beside it when it isn't 1×), from **Now playing's "Sound" shortcut** on phones (between Lyrics and Queue), and from **"Equalizer" in the track menus** (`equalizerActions`, the catalog pages' `EqualizerActions` seam, wired in `main.tsx`).
- **"Sleep timer paused playback"** in the app's toast when the timer paused something.

## How it is wired

| File | What |
|---|---|
| `effects-store.ts` | `useAudioEffectsStore`: the `AudioEffectsSettings`, always valid (`sanitizeAudioEffects`), persisted under `fxm.audio-effects.v1` and followed across tabs (`syncAudioEffectsAcrossTabs`, from `App`); and the sleep timer (`{ endsAt, minutes }` or `{ endOfTrack }`), never stored: a reload ends it |
| `connect.ts` | `connectAudioEffects(player)`: gives a player the settings now and on every change, and the sleep timer; when the player says its timer paused, the timer ends for every player and the toast says so. `createAppEngine()`: the direct audio engine with `isReadableHere`, which is `isMediaReadable` with the connection's platform and capabilities (`features/connect/connection.ts`), read whenever a stream loads |
| `status.ts` | The words: why the equalizer can't process a track, what loudness does to it, and the formats of speeds, lengths, gains and the time left |
| `equalizer-editor.tsx`, `effects-section.tsx` | The equalizer's editor and Settings → Sound |
| `sound-dialog.tsx`, `sound-dialog-host.tsx`, `sound-dialog-store.ts` | The Sound dialog; the host renders it from the app layout only while it is open, and loads it the first time it opens, so it stays out of the app's first download |
| `sound-button.tsx` | The player bar's Sound button and Now playing's shortcut, which open it |
| `download-loudness.ts` | `attachFileLoudness`: a completed download keeps its stream's loudness (YouTube's `loudnessDb`); when the stream said none, the downloads runtime fills it in from the file's own ReplayGain or R128 tags (music-metadata, loaded on first use), changing the record only while it is still that completed file |
| `equalizer-actions.ts` | "Equalizer" in the track menus |

The app's playback (`features/now-playing/playback.ts`) creates its engine with `createAppEngine()` and connects `connectAudioEffects(player)` first, before anything listens to the player: applying the effects updates the player's state. Local files play through that player too (stage 2.9), so their songs (always readable `blob:` URLs) get the equalizer, their ReplayGain level, crossfade, speed and the sleep timer. `connectAudioEffects` works for any number of players: each gets the sleep timer, the one that plays pauses, and that ends it for all. The embeddable mini-player (`src/embed`, stage 5.2) keeps its own player without effects.

## Tests

`effects-store.test.ts` (settings, presets, validation of stored data, the timer, tabs), `connect.test.ts` (a real `Player` on a `FakeEngine` following the store, the timer pausing it and the toast, disconnecting, readability by platform), `status.test.ts`, and `effects-section.test.tsx` and `sound-dialog.test.tsx`, which render the app (`renderApp`) on the test playback (`setupTestPlayback`) and use the switches, menus, sliders and chips as people do.
