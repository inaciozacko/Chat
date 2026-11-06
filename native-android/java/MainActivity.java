package app.zap.chat;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/** Tela única do app: o WebView do Capacitor com o Zap dentro. */
public class MainActivity extends BridgeActivity {

    /** app na tela? (com o app aberto, as notificações ficam por conta do próprio app, como no WhatsApp) */
    static volatile boolean visible = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ZapPlugin.class);
        super.onCreate(savedInstanceState);
        Notifs.ensureChannels(this);
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        // ligação chegando com a tela bloqueada: mostra o app por cima da tela de bloqueio (só nesse caso)
        if (intent != null && intent.getStringExtra("callId") != null && Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        ZapPlugin.handleIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    public void onPause() {
        super.onPause();
        visible = false;
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
        }
    }
}
