package io.github.pratyayops.fxm;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import io.github.pratyayops.fxm.http.DisabledCapacitorHttp;
import io.github.pratyayops.fxm.http.FxmHttpPlugin;
import io.github.pratyayops.fxm.player.FxmPlayerPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // FXM's own native HTTP (fxm-http): the web app's fetch on Android. Plugins that are not
        // npm packages must be registered before the bridge starts.
        registerPlugin(FxmHttpPlugin.class);
        // Replaces Capacitor's built-in CapacitorHttp plugin, which the bridge registers whatever
        // capacitor.config.ts says and which would let any script fetch any URL with the WebView's
        // cookies. The bridge registers the app's plugins after its own, so this one wins.
        registerPlugin(DisabledCapacitorHttp.class);
        // FXM's native player (fxm-player): Media3 in a foreground service. It also keeps the app
        // alive when the WebView's renderer dies, and brings the web app back.
        registerPlugin(FxmPlayerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
