package io.github.pratyayops.fxm.player

import androidx.media3.common.ForwardingSimpleBasePlayer
import androidx.media3.common.Player
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * The player the media session shows to the system's controls: Media3's player, except that
 * "next" and "previous" go to the [Coordinator], which hands them to the web app (it owns the
 * queue: shuffle, repeat, "previous" restarting after 3 s) or, without it, skips natively. Next
 * is offered while the web app may have more than the native playlist holds. Controls cannot
 * change the playlist, repeat, shuffle or speed: the web app's player decides those.
 */
class SessionPlayer(player: Player, private val controls: Controls) : ForwardingSimpleBasePlayer(player) {
  /** What the coordinator offers the system's controls. */
  interface Controls {
    val canSkipForward: Boolean
    val canSkipBack: Boolean

    fun next()

    fun previous()
  }

  override fun getState(): State {
    val state = super.getState()
    val commands = state.availableCommands.buildUpon().removeAll(*LOCKED)
    if (controls.canSkipForward) {
      commands.addAll(Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
    } else {
      commands.removeAll(Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
    }
    if (controls.canSkipBack) {
      commands.addAll(Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
    }
    return state.buildUpon().setAvailableCommands(commands.build()).build()
  }

  override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> =
    when (seekCommand) {
      Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> {
        controls.next()
        Futures.immediateVoidFuture()
      }
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> {
        controls.previous()
        Futures.immediateVoidFuture()
      }
      else -> super.handleSeek(mediaItemIndex, positionMs, seekCommand)
    }

  /** The controls' availability changed ([Controls.canSkipForward]). */
  fun controlsChanged() {
    invalidateState()
  }

  private companion object {
    /** Commands only the web app's player gives. */
    val LOCKED =
      intArrayOf(
        Player.COMMAND_CHANGE_MEDIA_ITEMS,
        Player.COMMAND_SET_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_MEDIA_ITEM,
        Player.COMMAND_SET_REPEAT_MODE,
        Player.COMMAND_SET_SHUFFLE_MODE,
        Player.COMMAND_SET_SPEED_AND_PITCH,
        Player.COMMAND_SET_PLAYLIST_METADATA,
      )
  }
}
