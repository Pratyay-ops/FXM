package io.github.pratyayops.fxm.evaluator;

import android.annotation.SuppressLint;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The isolated evaluator's host on Android (stage 1.11): where FXM runs YouTube's player script
 * and Google's BotGuard, which the app's own page must not run.
 *
 * <p>The plugin creates a separate WebView that is never attached to the screen, the pattern
 * NewPipe documents for its PoTokenWebView, and loads the evaluator document
 * ({@code apps/web/sandbox/eval.html}, handed in by the app) into it with
 * {@code https://www.youtube.com/} as its base URL, so BotGuard sees the location it expects.
 * Nothing is loaded from that URL: network loads are blocked, and the document's own
 * {@code <meta>} policy allows no connections. The WebView has no JavaScript interface; the app
 * reads the document's mailbox ({@code window.__fxmEvaluator}) through
 * {@code evaluateJavascript}, whose callback hands back the script's value as JSON.
 *
 * <p>The app's page drives it through {@code createCapacitorEvaluator} of
 * {@code packages/platform}: {@code open} loads the document, {@code eval} runs a script and
 * resolves with {@code { result }}, its value as JSON text, and {@code close} destroys the WebView.
 */
@CapacitorPlugin(name = "FxmEvaluator")
public class EvaluatorPlugin extends Plugin {

    /** The document's base URL: BotGuard's attestation needs YouTube's origin. */
    static final String BASE_URL = "https://www.youtube.com/";

    /** How long one {@code eval} may take before it is rejected. */
    static final long EVAL_TIMEOUT_MS = 15_000;

    private WebView webView;

    /** Creates the evaluator WebView (again) and loads {@code html} into it. */
    @PluginMethod
    public void open(PluginCall call) {
        String html = call.getString("html");
        if (html == null || html.isEmpty()) {
            call.reject("The evaluator document is missing");
            return;
        }
        getBridge()
            .executeOnMainThread(() -> {
                destroyWebView();
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
                Handler handler = new Handler(Looper.getMainLooper());
                boolean[] settled = { false };
                Runnable timeout = () -> {
                    if (settled[0]) return;
                    settled[0] = true;
                    call.reject("The evaluator did not answer in time");
                };
                handler.postDelayed(timeout, EVAL_TIMEOUT_MS);
                view.evaluateJavascript(script, (value) -> {
                    if (settled[0]) return;
                    settled[0] = true;
                    handler.removeCallbacks(timeout);
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
                destroyWebView();
                call.resolve();
            });
    }

    @Override
    protected void handleOnDestroy() {
        destroyWebView();
    }

    /** A WebView that runs scripts and nothing else: no network, files, storage or windows. */
    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView() {
        WebView view = new WebView(getContext());
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
        return view;
    }

    private void destroyWebView() {
        if (webView == null) return;
        webView.stopLoading();
        webView.destroy();
        webView = null;
    }
}
