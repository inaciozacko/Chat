package app.zap.chat;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/** Recebe os pushes do Firebase — funciona com o app fechado e a tela desligada. */
public class ZapMessagingService extends FirebaseMessagingService {

    @Override
    public void onNewToken(@NonNull String token) {
        Prefs.get(this).edit().putString("fcmToken", token).apply();
        ZapPlugin.emitToken(token); // app aberto: registra o token novo no Supabase
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> d = message.getData();
        String kind = d.get("kind");
        if (kind == null) return;
        Notifs.ensureChannels(this);

        // a ligação acabou: para de tocar mesmo com o app aberto
        if ("call_missed".equals(kind)) Notifs.cancelCall(this, d.get("callId"));

        // app na tela: ele mesmo avisa (som, contador, tela de chamada), como no WhatsApp
        if (MainActivity.visible) return;

        switch (kind) {
            case "message":
                Notifs.showMessage(this, d);
                break;
            case "call":
                Notifs.showCall(this, d);
                break;
            case "call_missed":
                Notifs.showMissed(this, d);
                break;
            case "mesh":
                Notifs.showMesh(this, Notifs.nz(d.get("title"), "🆘 Mensagem de emergência"), Notifs.nz(d.get("line"), "Abra o Zap para ler"));
                break;
            default:
                break;
        }
    }
}
