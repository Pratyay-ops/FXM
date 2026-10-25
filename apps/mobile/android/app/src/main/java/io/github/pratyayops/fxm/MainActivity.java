package io.github.pratyayops.fxm;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import io.github.pratyayops.fxm.http.FxmHttpPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // FXM's own native HTTP (fxm-http): the web app's fetch on Android. Plugins that are not
        // npm packages must be registered before the bridge starts.
        registerPlugin(FxmHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
