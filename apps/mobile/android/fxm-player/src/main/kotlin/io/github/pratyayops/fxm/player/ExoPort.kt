package io.github.pratyayops.fxm.player

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player

/** The [PlayerPort] over Media3's player: one playlist item per [Slot]. */
class ExoPort(private val player: Player) : PlayerPort {
  override val currentIndex: Int
    get() = if (player.mediaItemCount == 0) -1 else player.currentMediaItemIndex

  override val positionMs: Long
    get() = player.currentPosition

  override val durationMs: Long
    get() = player.duration.let { if (it == C.TIME_UNSET) -1 else it }

  override val playWhenReady: Boolean
    get() = player.playWhenReady

  override val isPlaying: Boolean
    get() = player.isPlaying

  override val state: PlaybackState
    get() =
      when (player.playbackState) {
        Player.STATE_BUFFERING -> PlaybackState.BUFFERING
        Player.STATE_READY -> PlaybackState.READY
        Player.STATE_ENDED -> PlaybackState.ENDED
        else -> PlaybackState.IDLE
      }

  override fun setSlots(slots: List<Slot>, index: Int, positionMs: Long) {
    player.setMediaItems(slots.map(::mediaItem), index, positionMs)
    player.prepare()
  }

  override fun replaceFrom(index: Int, slots: List<Slot>) {
    player.replaceMediaItems(index, player.mediaItemCount, slots.map(::mediaItem))
  }

  override fun replaceAt(index: Int, slot: Slot) {
    player.replaceMediaItem(index, mediaItem(slot))
  }

  override fun removeBefore(index: Int) {
    if (index > 0) player.removeMediaItems(0, index)
  }

  override fun seekTo(index: Int, positionMs: Long) {
    player.seekTo(index, positionMs)
  }

  override fun prepare() {
    player.prepare()
  }

  override fun setPlayWhenReady(playWhenReady: Boolean) {
    player.playWhenReady = playWhenReady
  }

  override fun setRepeatOne(repeatOne: Boolean) {
    player.repeatMode = if (repeatOne) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
  }

  override fun setVolume(volume: Float) {
    player.volume = volume
  }

  override fun clear() {
    player.stop()
    player.clearMediaItems()
  }

  companion object {
    /**
     * The playlist item for [slot]: its URI names the slot's bytes ([EntryUris]), its media id
     * the entry, and its metadata is what the notification and the lock screen show. Two items
     * of the same slot have equal URIs, so replacing one with the other only updates metadata.
     */
    fun mediaItem(slot: Slot): MediaItem {
      val meta = slot.entry.metadata
      val metadata =
        MediaMetadata.Builder()
          .setTitle(meta.title)
          .setArtist(meta.artists.joinToString(", ").ifEmpty { null })
          .setAlbumTitle(meta.album)
          .setArtworkUri(meta.artworkUrl?.let(Uri::parse))
          .setDurationMs(meta.durationMs)
          .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
          .setIsBrowsable(false)
          .setIsPlayable(true)
          .build()
      return MediaItem.Builder()
        .setMediaId(slot.entry.id)
        .setUri(EntryUris.uri(slot.key))
        .setMediaMetadata(metadata)
        .build()
    }
  }
}
