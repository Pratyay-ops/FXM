import { connectMediaSession, type MediaSessionOptions, type MediaSessionPlayer } from '@fxm/player'
import { useEffect } from 'react'

/**
 * Connects the app's player to the Media Session (2.2's `connectMediaSession`) while there is
 * one: the keyboard's media keys, headset buttons, the lock screen and the system's media
 * controls then play, pause, skip and seek, and show the track. In an installed app window this
 * is also how the media keys reach FXM. Disconnects when the player goes or the shell unmounts.
 *
 * `options` is for tests (a fake session); pass a stable object, or every render reconnects.
 */
export function useMediaKeys(
  player: MediaSessionPlayer | undefined,
  options?: MediaSessionOptions,
): void {
  useEffect(
    () => (player === undefined ? undefined : connectMediaSession(player, options)),
    [player, options],
  )
}
