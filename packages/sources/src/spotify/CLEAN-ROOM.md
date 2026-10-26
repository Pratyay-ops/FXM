# Spotify clean-room log

The Spotify provider's clean-room log is the [Clean-room log](README.md#clean-room-log) section of this folder's README, next to the description of how the provider works. For every protocol fact the provider relies on, it records where the fact came from and when: each persisted-query hash with the Spotify web-player file it was found in, the variables and response field paths, the token flow and key derivation, and the fixtures.

Before code relies on a new fact, add it there with its source and date, as the [clean-room rule](../../../../docs/LEGAL.md#clean-room-rule) requires.
