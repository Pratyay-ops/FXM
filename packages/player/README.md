# @fxm/player

The player facade and its engines. Every engine implements the same interface, and the facade switches between them track by track:

- **Direct audio** (`HTMLAudioElement`): stage 2.2
- **YouTube embedded player** (IFrame API, always visible, never hidden): stage 2.3
- **Native bridge** to the Android Media3 plugin: stage 6.3

Queue logic and the playback policy (which pipe plays a track) live in `@fxm/core`, so they are shared by every engine.

See [ARCHITECTURE.md §9](../../docs/ARCHITECTURE.md#9-playback).
