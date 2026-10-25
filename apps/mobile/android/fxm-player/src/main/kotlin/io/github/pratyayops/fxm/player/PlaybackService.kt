package io.github.pratyayops.fxm.player

import android.app.PendingIntent
import android.content.Intent
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import io.github.pratyayops.fxm.http.FxmHttp

/**
 * FXM's native player: Media3's ExoPlayer in a `mediaPlayback` foreground service, with the media
 * notification and lock-screen controls of its [MediaSession]. Media3 starts the foreground
 * service when playback starts and keeps it while playing (and for 10 minutes after a pause or a
 * failure), which keeps the app's process out of Android's cached-app freezer, and with it the
 * WebView whose JavaScript resolves the streams.
 *
 * Every request, audio and artwork alike, goes through fxm-http's shared OkHttp client
 * ([FxmHttp.client]): FXM's host and header rules, its own cookie jar, a browser `User-Agent`.
 * The [Coordinator] decides what plays; the FxmPlayer plugin binds this service to reach it.
 */
class PlaybackService : MediaSessionService() {
  private val handler = Handler(Looper.getMainLooper())
  private val localBinder = LocalBinder()
  private lateinit var player: ExoPlayer
  private lateinit var sessionPlayer: SessionPlayer
  private lateinit var session: MediaSession
  private lateinit var network: NetworkWatcher
  private var visible = true

  /** The native player's logic. Use on the main thread only. */
  lateinit var coordinator: Coordinator
    private set

  private val ticker =
    object : Runnable {
      override fun run() {
        coordinator.tick()
        handler.postDelayed(this, if (visible) TICK_VISIBLE_MS else TICK_HIDDEN_MS)
      }
    }

  override fun onCreate() {
    super.onCreate()
    val client = FxmHttp.client(this)
    val table = SourceTable()
    val media =
      ProgressiveMediaSource.Factory(
        ResolvingDataSource.Factory(OkHttpDataSource.Factory(client), EntryResolver(table)),
      ).setLoadErrorHandlingPolicy(LoadErrorPolicy())
    player =
      ExoPlayer.Builder(this)
        .setMediaSourceFactory(media)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build(),
          /* handleAudioFocus= */ true,
        )
        .setHandleAudioBecomingNoisy(true)
        // A partial wake lock and a Wi-Fi lock while playing: streaming with the screen off.
        .setWakeMode(C.WAKE_MODE_NETWORK)
        .setLoadControl(loadControl())
        .build()
    // Audio only: itag 18 is a video file, whose picture nothing shows.
    player.trackSelectionParameters =
      player.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, true).build()

    coordinator =
      Coordinator(ExoPort(player), table, WebViewRecovery, { System.currentTimeMillis() }, HandlerScheduler(handler))
    sessionPlayer =
      SessionPlayer(
        player,
        object : SessionPlayer.Controls {
          override val canSkipForward: Boolean
            get() = coordinator.canSkipForward

          override val canSkipBack: Boolean
            get() = coordinator.canSkipBack

          override fun next() = coordinator.onSystemNext()

          override fun previous() = coordinator.onSystemPrevious()
        },
      )
    coordinator.onControlsChanged = { handler.post { sessionPlayer.controlsChanged() } }
    player.addListener(Events())

    session =
      MediaSession.Builder(this, sessionPlayer)
        .setId(SESSION_ID)
        .apply { sessionActivity()?.let { setSessionActivity(it) } }
        // Artwork through FXM's network rules too; the default loader would use HttpURLConnection.
        .setBitmapLoader(
          DataSourceBitmapLoader.Builder(this)
            .setDataSourceFactory(OkHttpDataSource.Factory(client))
            .build(),
        )
        .build()
    setMediaNotificationProvider(
      DefaultMediaNotificationProvider.Builder(this).build().apply {
        setSmallIcon(R.drawable.fxm_notification_icon)
      },
    )
    addSession(session)

    network =
      NetworkWatcher(
        this,
        handler,
        object : NetworkWatcher.Listener {
          override fun onNetworkChanged(cellular: Boolean) = coordinator.onNetworkChanged(cellular)

          override fun onCellularChanged(cellular: Boolean) = coordinator.onCellularChanged(cellular)
        },
      )
    network.start()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = session

  override fun onBind(intent: Intent?): IBinder? {
    val binder = super.onBind(intent)
    return if (intent?.action == ACTION_BIND) localBinder else binder
  }

  /** Whether the app is on screen: state reaches it every second then, else every 5 s. */
  fun setVisible(visible: Boolean) {
    this.visible = visible
  }

  override fun onDestroy() {
    // The ticker, and whatever the coordinator scheduled: nothing may reach a released player.
    handler.removeCallbacksAndMessages(null)
    network.stop()
    session.release()
    sessionPlayer.release()
    super.onDestroy()
  }

  /** What the FxmPlayer plugin gets when it binds with [ACTION_BIND]: this service. */
  inner class LocalBinder : Binder() {
    val service: PlaybackService
      get() = this@PlaybackService
  }

  private inner class Events : Player.Listener {
    override fun onMediaItemTransition(mediaItem: androidx.media3.common.MediaItem?, reason: Int) {
      when (reason) {
        Player.MEDIA_ITEM_TRANSITION_REASON_AUTO -> coordinator.onAutoTransition(repeated = false)
        Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT -> coordinator.onAutoTransition(repeated = true)
      }
    }

    override fun onPlaybackStateChanged(playbackState: Int) = coordinator.onStateChanged()

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = coordinator.onStateChanged()

    override fun onPositionDiscontinuity(
      oldPosition: Player.PositionInfo,
      newPosition: Player.PositionInfo,
      reason: Int,
    ) = coordinator.onStateChanged()

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      handler.removeCallbacks(ticker)
      if (isPlaying) handler.postDelayed(ticker, if (visible) TICK_VISIBLE_MS else TICK_HIDDEN_MS)
      coordinator.onStateChanged()
    }

    override fun onPlayerError(error: PlaybackException) = coordinator.onError(Failures.of(error))
  }

  /** The app's own screen, opened by a tap on the notification. */
  private fun sessionActivity(): PendingIntent? {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    return PendingIntent.getActivity(
      this,
      0,
      launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  companion object {
    /** The action the FxmPlayer plugin binds with, to reach the [LocalBinder]. */
    const val ACTION_BIND = "io.github.pratyayops.fxm.player.BIND"

    private const val SESSION_ID = "fxm"
    private const val TICK_VISIBLE_MS = 1_000L
    private const val TICK_HIDDEN_MS = 5_000L

    /**
     * Whole songs ahead: up to 10 minutes or 32 MiB, at least 2 minutes. A buffered track keeps
     * playing through a network change, and the radio sleeps between bursts with the screen off.
     */
    private fun loadControl(): DefaultLoadControl =
      DefaultLoadControl.Builder()
        .setBufferDurationsMs(120_000, 600_000, 1_500, 3_000)
        .setTargetBufferBytes(32 * 1024 * 1024)
        .build()
  }
}
