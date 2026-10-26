package io.github.pratyayops.fxm.evaluator;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.webkit.WebViewRenderProcess;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;

/**
 * The isolated evaluator's host on Android (stage 1.11): where FXM runs YouTube's player script
 * and Google's BotGuard, which the app's own page must not run.
 *
 * <p>The plugin creates a separate WebView that is never attached to the screen, the pattern
 * NewPipe documents for its PoTokenWebView, and loads the evaluator document
 * ({@code apps/web/sandbox/eval.html}, handed in by the app and checked against its SHA-256 in
 * {@link EvaluatorDocument}) into it with {@code https://www.youtube.com/} as its base URL, so
 * BotGuard sees the location it expects. What keeps it apart:
 *
 * <ul>
 *   <li>Nothing is loaded from that URL: network loads are blocked, and the document's own
 *       {@code <meta>} policy allows no connections. Every navigation and every new window is
 *       refused.
 *   <li>It runs in a WebView profile of its own ({@value #PROFILE}), whose cookies and storage are
 *       cleared before it opens and after it closes, so its scripts never see a cookie of the
 *       app's other WebViews, such as a Google sign-in. Where the WebView has no profiles, the
 *       evaluator doesn't open.
 *   <li>It has no JavaScript interface: the app reads the document's mailbox
 *       ({@code window.__fxmEvaluator}) through {@code evaluateJavascript}, whose callback hands
 *       back the script's value as JSON.
 *   <li>All of the app's WebViews share one renderer process. If it dies, the evaluator's WebView
 *       is destroyed and the app's own is replaced by restarting the activity, instead of Android
 *       killing the app; and if a script hangs it (a mailbox read that takes {@value
 *       #EVAL_TIMEOUT_MS} ms), the renderer is ended, where the WebView allows it.
 * </ul>
 *
 * <p>The app's page drives it through {@code createCapacitorEvaluator} of
 * {@code packages/platform}: {@code open} loads the document, {@code eval} runs a script and
 * resolves with {@code { result }}, its value as JSON text, and {@code close} destroys the WebView.
 */
@CapacitorPlugin(name = "FxmEvaluator")
public class EvaluatorPlugin extends Plugin {

    /** The document's base URL: BotGuard's attestation needs YouTube's origin. */
    static final String BASE_URL = "https://www.youtube.com/";

    /** The WebView profile the evaluator runs in, apart from the app's own. */
    static final String PROFILE = "fxm-evaluator";

    /** How long one {@code eval} may take before it is rejected. */
    static final long EVAL_TIMEOUT_MS = 15_000;

    /** A call waiting for the evaluator WebView, on the main thread. */
    private static final class Pending {
        final PluginCall call;
        final Runnable timeout;

        Pending(PluginCall call, Runnable timeout) {
            this.call = call;
            this.timeout = timeout;
        }
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Pending> pending = new ArrayList<>();
    private WebView webView;
    private boolean guardingRenderer;

    /**
     * Keeps the app alive when the renderer it shares with the evaluator dies: the app's WebView
     * can't be used any more, so the activity starts again with a new one.
     */
    private final WebViewListener rendererGuard = new WebViewListener() {
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            main.post(() -> {
                destroyWebView("The evaluator's renderer is gone");
                Activity activity = getActivity();
                if (activity != null && !activity.isFinishing()) activity.recreate();
            });
            return true;
        }
    };

    /** Creates the evaluator WebView (again) and loads {@code html} into it. */
    @PluginMethod
    public void open(PluginCall call) {
        String html = call.getString("html");
        if (html == null || !EvaluatorDocument.SHA256.equals(sha256(html))) {
            call.reject("This is not the evaluator document this app was built with");
            return;
        }
        getBridge()
            .executeOnMainThread(() -> {
                destroyWebView("The evaluator was restarted");
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                    call.reject(
                        "This WebView has no profiles, so the evaluator can't be kept apart from the app's cookies"
                    );
                    return;
                }
                clearProfile();
                if (!guardingRenderer) {
                    getBridge().addWebViewListener(rendererGuard);
                    guardingRenderer = true;
                }
                webView = createWebView();
                webView.loadDataWithBaseURL(BASE_URL, html, "text/html", "utf-8", null);
                call.resolve();
            });
    }

    /** Runs {@code script} in the evaluator WebView and resolves with its value as JSON text. */
    @PluginMethod
    public void eval(PluginCall call) {
        String script = call.getString("script");
        if (script == null) {
            call.reject("There is no script to run");
            return;
        }
        getBridge()
            .executeOnMainThread(() -> {
                WebView view = webView;
                if (view == null) {
                    call.reject("The evaluator is not open");
                    return;
                }
                Pending[] entry = { null };
                Runnable timeout = () -> {
                    if (!pending.remove(entry[0])) return;
                    call.reject("The evaluator did not answer in time");
                    // A mailbox read is instant unless a script holds the renderer: end it.
                    terminateRenderer(view);
                };
                entry[0] = new Pending(call, timeout);
                pending.add(entry[0]);
                main.postDelayed(timeout, EVAL_TIMEOUT_MS);
                view.evaluateJavascript(script, (value) -> {
                    if (!pending.remove(entry[0])) return;
                    main.removeCallbacks(timeout);
                    JSObject result = new JSObject();
                    result.put("result", value);
                    call.resolve(result);
                });
            });
    }

    /** Destroys the evaluator WebView. */
    @PluginMethod
    public void close(PluginCall call) {
        getBridge()
            .executeOnMainThread(() -> {
                destroyWebView("The evaluator was stopped");
                call.resolve();
            });
    }

    @Override
    protected void handleOnDestroy() {
        destroyWebView("The app is closing");
        if (guardingRenderer) {
            getBridge().removeWebViewListener(rendererGuard);
            guardingRenderer = false;
        }
    }

    /** A WebView that runs scripts and nothing else: no network, files, storage or windows. */
    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView() {
        WebView view = new WebView(getContext());
        // First of all: a profile can only be set on a WebView that hasn't been used.
        WebViewCompat.setProfile(view, PROFILE);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setBlockNetworkLoads(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setDomStorageEnabled(false);
        settings.setGeolocationEnabled(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Its document stays its document.
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Handled: the WebView is destroyed, and Android leaves the app running.
                if (view == webView) destroyWebView("The evaluator's renderer is gone");
                return true;
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(
                WebView view,
                boolean isDialog,
                boolean isUserGesture,
                Message resultMsg
            ) {
                return false;
            }
        });
        return view;
    }

    /** Ends the renderer process, where the WebView allows it. */
    private static void terminateRenderer(WebView view) {
        if (
            !WebViewFeature.isFeatureSupported(WebViewFeature.GET_WEB_VIEW_RENDERER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_VIEW_RENDERER_TERMINATE)
        ) return;
        WebViewRenderProcess renderer = WebViewCompat.getWebViewRenderProcess(view);
        if (renderer != null) renderer.terminate();
    }

    /** Clears the cookies and storage of the evaluator's profile. */
    private static void clearProfile() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return;
        Profile profile = ProfileStore.getInstance().getOrCreateProfile(PROFILE);
        profile.getCookieManager().removeAllCookies(null);
        profile.getWebStorage().deleteAllData();
    }

    /** Destroys the evaluator WebView, rejecting what waits for it with {@code reason}. */
    private void destroyWebView(String reason) {
        for (Pending entry : new ArrayList<>(pending)) {
            main.removeCallbacks(entry.timeout);
            entry.call.reject(reason);
        }
        pending.clear();
        if (webView == null) return;
        WebView view = webView;
        webView = null;
        view.stopLoading();
        view.destroy();
        clearProfile();
    }

    /** The SHA-256 of {@code text} (UTF-8, line endings as LF), as lowercase hexadecimal. */
    static String sha256(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                text.replace("\r\n", "\n").getBytes(StandardCharsets.UTF_8)
            );
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte value : digest) hex.append(String.format("%02x", value & 0xff));
            return hex.toString();
        } catch (NoSuchAlgorithmException error) {
            return "";
        }
    }
}
