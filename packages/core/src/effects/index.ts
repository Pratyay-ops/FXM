/**
 * Audio effects (stage 8.1): the pure parts. The equalizer's bands, presets and curve, loudness
 * normalization (how loud a stream is and the gain that brings it to the target), crossfade and
 * playback speed, and the settings that hold them. The player applies them (`@fxm/player`: Web
 * Audio on the web and the desktop app, Media3 on Android). See `README.md` in this folder.
 *
 * @module
 */

export * from './biquad'
export * from './equalizer'
export * from './loudness'
export * from './settings'
