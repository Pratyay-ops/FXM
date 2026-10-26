package io.github.pratyayops.fxm.downloads

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * The `dataSync` foreground service that keeps FXM running while its downloads do
 * ([BackgroundDownloads] decides when). It does no work itself: the web app's download manager
 * fetches and writes in the WebView, which keeps running as long as the process is not cached.
 * Its notification shows the downloads' progress and opens the app.
 */
class DownloadService : Service() {
  /** The start this instance runs for ([BackgroundDownloads] numbers them), told when it ends. */
  private var generation = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    intent?.let { generation = it.getLongExtra(EXTRA_GENERATION, generation) }
    val notice = intent?.let(::noticeOf) ?: Notice("Downloading", null, true)
    val started =
      try {
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(this, notice), FOREGROUND_TYPE)
        true
      } catch (e: RuntimeException) {
        // ForegroundServiceStartNotAllowedException and its kind: the app went to the background.
        false
      }
    if (!started) {
      controller?.serviceStopped(timedOut = false, generation = generation)
      stopSelf(startId)
    }
    // Never restarted without the page: the queue lives in the web app.
    return START_NOT_STICKY
  }

  /** Android 15's daily time limit for `dataSync` services is reached: stop at once. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    controller?.serviceStopped(timedOut = true, generation = generation)
    stopSelf()
  }

  override fun onDestroy() {
    // After a stop the controller made itself, this may come after its next start: the generation
    // tells it apart.
    controller?.serviceStopped(timedOut = false, generation = generation)
    super.onDestroy()
  }

  companion object {
    /** The notification channel: low importance, so progress makes no sound. */
    const val CHANNEL = "fxm-downloads"
    const val NOTIFICATION_ID = 6_404

    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"
    private const val EXTRA_DOWNLOADING = "downloading"
    private const val EXTRA_GENERATION = "generation"
    private const val WAKE_LOCK_TAG = "fxm:downloads"

    /** How long the wake lock lasts unless renewed (at half that, while it is wanted). */
    private const val WAKE_LOCK_MS = 10 * 60_000L

    private val FOREGROUND_TYPE =
      if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0

    /** Hears when Android stops the service. The plugin sets it. */
    @Volatile var controller: BackgroundDownloads? = null

    /** The [DownloadServiceControl] over this service, for [BackgroundDownloads]. */
    fun control(context: Context): DownloadServiceControl = Control(context.applicationContext)

    private fun noticeOf(intent: Intent): Notice? {
      val title = intent.getStringExtra(EXTRA_TITLE) ?: return null
      return Notice(title, intent.getStringExtra(EXTRA_TEXT), intent.getBooleanExtra(EXTRA_DOWNLOADING, false))
    }

    private fun intent(context: Context, notice: Notice, generation: Long): Intent =
      Intent(context, DownloadService::class.java)
        .putExtra(EXTRA_TITLE, notice.title)
        .putExtra(EXTRA_TEXT, notice.text)
        .putExtra(EXTRA_DOWNLOADING, notice.downloading)
        .putExtra(EXTRA_GENERATION, generation)

    private fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < 26) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      if (manager.getNotificationChannel(CHANNEL) != null) return
      val channel = NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW)
      channel.description = "Songs FXM is downloading"
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }

    /** The progress notification: the system's download icon, and a tap opens FXM. */
    fun notification(context: Context, notice: Notice): Notification {
      ensureChannel(context)
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val open =
        launch?.let {
          PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
      return NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(if (notice.downloading) android.R.drawable.stat_sys_download else android.R.drawable.stat_sys_download_done)
        .setContentTitle(notice.title)
        .setContentText(notice.text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setProgress(0, 0, notice.downloading)
        .apply { open?.let(::setContentIntent) }
        .build()
    }
  }

  /** Starts, updates and stops the service, and holds its locks. */
  private class Control(private val context: Context) : DownloadServiceControl {
    private val main = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun start(notice: Notice, generation: Long): Boolean =
      try {
        ContextCompat.startForegroundService(context, intent(context, notice, generation))
        true
      } catch (e: RuntimeException) {
        // ForegroundServiceStartNotAllowedException (Android 12+) from the background.
        false
      }

    @SuppressLint("MissingPermission")
    override fun update(notice: Notice) {
      // POST_NOTIFICATIONS refused (Android 13+): the service runs, its notice only shows in
      // the system's list of running apps.
      runCatching { NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification(context, notice)) }
    }

    override fun stop() {
      keepAwake(false)
      context.stopService(Intent(context, DownloadService::class.java))
    }

    @Suppress("DEPRECATION")
    override fun keepAwake(awake: Boolean) {
      main.removeCallbacksAndMessages(null)
      if (!awake) {
        wakeLock?.takeIf { it.isHeld }?.release()
        wifiLock?.takeIf { it.isHeld }?.release()
        return
      }
      val wake =
        wakeLock ?: context.getSystemService(PowerManager::class.java)
          ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
          ?.apply { setReferenceCounted(false) }
      wakeLock = wake
      // With a timeout, so a lost release can't hold it for long; renewed while still wanted.
      wake?.acquire(WAKE_LOCK_MS)
      main.postDelayed({ keepAwake(true) }, WAKE_LOCK_MS / 2)
      val wifi =
        wifiLock ?: context.getSystemService(WifiManager::class.java)
          ?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, WAKE_LOCK_TAG)
          ?.apply { setReferenceCounted(false) }
      wifiLock = wifi
      if (wifi?.isHeld == false) wifi.acquire()
    }
  }
}
