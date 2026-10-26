package io.github.pratyayops.fxm.spotify

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * The Spotify login window (stage 6.5): Spotify's own login page in a WebView of its own, which
 * the FxmSpotifyLogin plugin opens.
 *
 * - **Apart from the app.** The WebView runs in the profile [SpotifyLogin.PROFILE], whose cookies
 *   and storage the app's WebView never shares. It has no JavaScript interface, runs no script of
 *   FXM's and sees no request's body: the password goes from Spotify's page to Spotify, and FXM
 *   never handles it.
 * - **Spotify's pages only** ([LoginPage.navigation]). Google and Facebook refuse sign-ins in app
 *   windows, so choosing theirs shows why, and a link to Spotify's password reset helps accounts
 *   made with them.
 * - **The login.** Once Spotify sets its `sp_dc` login cookie in the profile, the window keeps it
 *   ([SessionStore], sealed with a Keystore key), clears the profile and closes with
 *   [RESULT_OK], or [RESULT_NOT_KEPT] when it couldn't keep it. Each login starts from an empty
 *   profile; closing the window keeps an earlier login.
 */
class SpotifyLoginActivity : AppCompatActivity() {
  private val main = Handler(Looper.getMainLooper())
  private var webView: WebView? = null
  private var cookies: CookieManager? = null
  private lateinit var notice: TextView
  private lateinit var progress: ProgressBar
  private var opened = false
  private var done = false

  /** Looks for the login cookie while the window is in front: some steps set it without a page. */
  private val watch: Runnable =
    object : Runnable {
      override fun run() {
        capture()
        if (!done) main.postDelayed(this, WATCH_MS)
      }
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // The plugin opens the window only where SpotifyLogin.windowAvailable() said yes.
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      close()
      return
    }
    opened = true
    open = true
    WindowCompat.setDecorFitsSystemWindows(window, false)
    setContentView(R.layout.fxm_spotify_login)
    val root = findViewById<View>(R.id.fxm_spotify_login_root)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val edges =
        insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or
            WindowInsetsCompat.Type.displayCutout() or
            WindowInsetsCompat.Type.ime(),
        )
      view.setPadding(edges.left, edges.top, edges.right, edges.bottom)
      WindowInsetsCompat.CONSUMED
    }
    WindowCompat.getInsetsController(window, root).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }
    findViewById<Toolbar>(R.id.fxm_spotify_login_toolbar).setNavigationOnClickListener { close() }
    notice = findViewById(R.id.fxm_spotify_login_notice)
    progress = findViewById(R.id.fxm_spotify_login_progress)
    findViewById<View>(R.id.fxm_spotify_login_password).setOnClickListener {
      webView?.loadUrl(LoginPage.PASSWORD_RESET_URL)
    }
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val view = webView
          if (view != null && view.canGoBack()) view.goBack() else close()
        }
      },
    )
    emptyProfile()
  }

  /**
   * Empties the login profile, then opens the page: each login starts from nothing, not even what
   * an earlier, abandoned one left. Only [onCreate] calls it, after its check for profiles.
   */
  @SuppressLint("RequiresFeature")
  private fun emptyProfile() {
    val profile = ProfileStore.getInstance().getOrCreateProfile(SpotifyLogin.PROFILE)
    cookies = profile.cookieManager
    profile.webStorage.deleteAllData()
    profile.cookieManager.removeAllCookies { if (!isFinishing && !isDestroyed) openPage() }
  }

  override fun onResume() {
    super.onResume()
    if (webView != null && !done) watchAgain()
  }

  override fun onPause() {
    main.removeCallbacks(watch)
    super.onPause()
  }

  override fun onDestroy() {
    main.removeCallbacksAndMessages(null)
    webView?.let(::discard)
    webView = null
    if (opened) open = false
    super.onDestroy()
  }

  /** Adds the WebView, now that its profile is empty, and loads Spotify's login page. */
  private fun openPage() {
    val view = createWebView()
    findViewById<FrameLayout>(R.id.fxm_spotify_login_page)
      .addView(
        view,
        FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT,
        ),
      )
    webView = view
    view.loadUrl(LoginPage.START_URL)
    watchAgain()
  }

  private fun watchAgain() {
    main.removeCallbacks(watch)
    main.post(watch)
  }

  /** Keeps the login as soon as Spotify set its cookie, then closes the window. */
  private fun capture() {
    if (done) return
    val cookie = LoginPage.sessionCookie(cookies?.getCookie(LoginPage.COOKIE_URL)) ?: return
    done = true
    main.removeCallbacks(watch)
    webView?.stopLoading()
    val kept =
      try {
        SpotifyLogin.store(this).save(cookie)
        true
      } catch (e: Exception) {
        false
      }
    // From here on the login lives in the kept file alone. The next login clears the profile
    // again first, should this fail.
    runCatching { SpotifyLogin.clearWindow() }
    setResult(if (kept) RESULT_OK else RESULT_NOT_KEPT)
    finish()
  }

  /**
   * A WebView in the login profile, for Spotify's pages: no files, windows, location or bridge.
   * Only [onCreate]'s flow calls it, after its check that the WebView has profiles.
   */
  @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
  private fun createWebView(): WebView {
    val view = WebView(this)
    // First of all: a profile can only be set on a WebView that hasn't been used.
    WebViewCompat.setProfile(view, SpotifyLogin.PROFILE)
    view.settings.apply {
      // Spotify's login page is a script.
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      setGeolocationEnabled(false)
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      userAgentString = LoginPage.loginUserAgent(userAgentString)
    }
    view.webViewClient =
      object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
          if (!request.isForMainFrame) return false
          return when (val where = LoginPage.navigation(request.url.toString())) {
            Navigation.Allowed -> false
            Navigation.Elsewhere -> {
              say(getString(R.string.fxm_spotify_login_elsewhere))
              true
            }
            is Navigation.NotHere -> {
              say(getString(R.string.fxm_spotify_login_not_here, where.provider))
              true
            }
          }
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
          progress.visibility = View.VISIBLE
          capture()
        }

        override fun onPageFinished(view: WebView, url: String?) {
          progress.visibility = View.INVISIBLE
          capture()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
          capture()
        }

        override fun onReceivedError(
          view: WebView,
          request: WebResourceRequest,
          error: WebResourceError,
        ) {
          if (request.isForMainFrame) say(getString(R.string.fxm_spotify_login_offline))
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
          // Handled: the window closes and Android keeps the app running. The app's own WebView
          // shares the renderer; the FxmPlayer plugin brings it back.
          if (view == webView) {
            webView = null
            discard(view)
            close()
          }
          return true
        }
      }
    // The default client refuses permission requests, file choosers and new windows.
    view.webChromeClient = WebChromeClient()
    return view
  }

  private fun say(text: String) {
    notice.text = text
  }

  private fun close() {
    setResult(RESULT_CANCELED)
    finish()
  }

  private fun discard(view: WebView) {
    view.stopLoading()
    (view.parent as? ViewGroup)?.removeView(view)
    view.destroy()
  }

  companion object {
    /** The result when the login worked but couldn't be kept (the keystore or the disk failed). */
    const val RESULT_NOT_KEPT = RESULT_FIRST_USER

    /** How often the window looks for the login cookie while it is in front. */
    private const val WATCH_MS = 1000L

    /** Whether a login window is open, so the plugin never opens a second one. */
    @Volatile
    var open = false
      private set
  }
}
