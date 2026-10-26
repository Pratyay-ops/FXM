# Audio effects: the pure parts (`effects/`)

Stage 8.1. What every platform computes the same way: the equalizer's filters and curve, the loudness gain, the crossfade curve and the settings. The player applies them (`@fxm/player`: Web Audio in the direct audio engine on the web and the desktop app, Media3 in the Android app's native player, whose Kotlin computes the same numbers, see `apps/mobile/android/fxm-player/.../Effects.kt`).

| File | What |
|---|---|
| `biquad.ts` | Second-order filters exactly as Web Audio's `BiquadFilterNode` computes them (the specification's "Filters characteristics", after the Audio EQ Cookbook): `biquadCoefficients` (peaking and both shelves), `biquadMagnitudeDb` (what `getFrequencyResponse` reports, in dB), and `applyBiquad` to filter samples offline, for tests |
| `equalizer.ts` | The ten bands (`EQUALIZER_BANDS_HZ`: 31 Hz to 16 kHz, an octave apart), one peaking filter each with a Q of √2, gains from −12 to +12 dB in half decibels; fifteen presets (`EQUALIZER_PRESETS`, Flat first); `EqualizerSettings` (`enabled`, `gainsDb`, `preset`, `custom` once a band moved away from a preset) and `sanitizeEqualizer`; `equalizerResponseDb`, the curve the cascade plays, and `equalizerHeadroomDb`, the level drop that keeps boosts from clipping |
| `loudness.ts` | `StreamLoudness` (`trackLufs`, `trackPeak`, `albumLufs`, `albumPeak`, `source`), what a `StreamOption` carries as `loudness`, and where it comes from (`loudnessFromReplayGain`, `loudnessFromR128`, `loudnessFromYouTube`, `parseReplayGainDb`, `parseR128GainDb`, `sanitizeStreamLoudness`); `LoudnessSettings` (`enabled`, `targetLufs`, `mode`) and `sanitizeLoudness`; `loudnessGainDb`, the gain to the target |
| `settings.ts` | `CrossfadeSettings` (`durationMs` 0–12 s, `sameAlbum`), the speed (0.5–2 in steps of 0.05, `PLAYBACK_RATE_PRESETS`), `AudioEffectsSettings` with `DEFAULT_AUDIO_EFFECTS` and `sanitizeAudioEffects`, and `crossfadeGains`, the equal-power curve |

## The equalizer

A graphic equalizer: each slider sets the gain at its own frequency, because every band is a peaking filter (no shelves at the ends, which would put only half the gain at the labelled frequency). Neighbouring bands overlap, so the curve (`equalizerResponseDb`) shows what the cascade really does: Bass boost peaks at about +7 dB, a little over its largest band.

**Headroom.** Boosting a loud master would clip, so every platform lowers the level before the filters by the curve's highest point between 20 Hz and 20 kHz (`equalizerHeadroomDb`, rounded to 0.01 dB): a +6 dB bass boost makes everything else 6 dB quieter rather than distorting. Cuts need no headroom. There is no manual preamp.

## Loudness

Every source becomes an integrated loudness in LUFS, so one target fits them all:

| Source | What it says | As loudness |
|---|---|---|
| ReplayGain tags (`REPLAYGAIN_TRACK_GAIN` and `_PEAK`, and the album pair) | The gain to ReplayGain's reference, which ReplayGain 2.0 puts at −18 LUFS (chosen to match ReplayGain 1.0's 89 dB), and the largest sample (linear) | `trackLufs = −18 − gain` |
| Opus R128 tags (`R128_TRACK_GAIN`, `R128_ALBUM_GAIN`; RFC 7845 §5.2.1) | A Q7.8 gain (the value / 256, in dB) to −23 LUFS, on top of the header's output gain the decoder applies; no peak | `trackLufs = −23 − gain` |
| YouTube (`loudnessDb` per format of a `/player` response) | How far the video is above YouTube's reference playback level, −14 LUFS since 2019; YouTube turns a video down by that much and never up ([the clean-room log](../../../sources/src/youtube/stream/CLEAN-ROOM.md#loudness-stage-81)); no peak | `trackLufs = loudnessDb − 14` |

`loudnessGainDb(loudness, settings, { boost })` is `target − loudness`, with these rules:

- **Down always.** A loud track is turned down, by at most 30 dB. At the default target of −14 LUFS a YouTube song plays exactly as loud as on YouTube.
- **Up only with a peak, and only where the player can.** A quiet track is turned up only where the player processes the audio itself (`boost`: Web Audio on readable bytes) and the source says its peak, and only as far as the peak allows without clipping (ReplayGain's clipping prevention), at most 12 dB. YouTube and R128 give no peak, so their quiet tracks play as they are, as on YouTube.
- **Album mode** uses the album's loudness and peak where the tags give them, else the track's.

The targets Settings offers (`LOUDNESS_TARGETS`): Normal (−14 LUFS, the default), Quiet (−18) and Quietest (−23). Normalization is on by default.

## Crossfade and speed

`crossfadeGains(progress)` gives the outgoing track `cos(p·π/2)` and the incoming one `sin(p·π/2)`: their powers add up to 1, so two unrelated songs keep their loudness through the fade. The player decides when (see `@fxm/player`'s README); a crossfade is 0 (off, the default) to 12 s, in whole seconds, and by default not between two tracks of the same album. The speed goes from 0.5 to 2 in steps of 0.05; every platform keeps the pitch.

## Tests

`biquad.test.ts` checks the coefficients against the specification's formulas worked by hand, the magnitudes, and filtering a sine against the magnitude it should have. `equalizer.test.ts` checks the presets, the validation, each band's gain at its frequency, the cascade against filtered sines, and the headroom. `loudness.test.ts` and `settings.test.ts` cover the conversions, the gain rules and the validation.
