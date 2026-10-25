package io.github.pratyayops.fxm;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import io.github.pratyayops.fxm.evaluator.EvaluatorPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The isolated evaluator's WebView (stage 1.11).
        registerPlugin(EvaluatorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
