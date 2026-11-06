package app.zap.chat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import androidx.core.app.RemoteInput;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

/** Botões das notificações: Responder (sem abrir o app), Marcar como lida, Recusar ligação. */
public class ActionReceiver extends BroadcastReceiver {

    static final String ACTION_REPLY = "app.zap.chat.REPLY";
    static final String ACTION_READ = "app.zap.chat.READ";
    static final String ACTION_DECLINE = "app.zap.chat.DECLINE";
    static final String ACTION_DISMISS = "app.zap.chat.DISMISS";

    @Override
    public void onReceive(Context context, Intent intent) {
        final Context ctx = context.getApplicationContext();
        final String action = intent.getAction();
        final String conv = intent.getStringExtra("conversationId");
        final String callId = intent.getStringExtra("callId");
        if (action == null) return;

        if (ACTION_DISMISS.equals(action)) {
            // dispensou a notificação: a próxima começa do zero
            if (conv != null) {
                Notifs.saveHistory(ctx, conv, new org.json.JSONArray());
                Notifs.resetMissed(ctx, conv);
            }
            return;
        }

        String typed = null;
        if (ACTION_REPLY.equals(action)) {
            Bundle results = RemoteInput.getResultsFromIntent(intent);
            CharSequence cs = results == null ? null : results.getCharSequence(Notifs.KEY_REPLY);
            typed = cs == null ? "" : cs.toString().trim();
            if (typed.isEmpty()) {
                Notifs.render(ctx, conv, true, null);
                return;
            }
        }
        if (ACTION_DECLINE.equals(action)) Notifs.cancelCall(ctx, callId);
        if (ACTION_READ.equals(action) && conv != null) Notifs.clearConversation(ctx, conv);

        final String text = typed;
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("secret", Prefs.secret(ctx));
                if (ACTION_REPLY.equals(action)) {
                    body.put("action", "reply");
                    body.put("conversation_id", conv);
                    body.put("text", text);
                    body.put("id", UUID.randomUUID().toString());
                } else if (ACTION_READ.equals(action)) {
                    body.put("action", "read");
                    body.put("conversation_id", conv);
                } else if (ACTION_DECLINE.equals(action)) {
                    body.put("action", "decline");
                    body.put("call_id", callId);
                }
                int status = post(Prefs.apiBase(ctx) + "/api/reply", body);
                if (ACTION_REPLY.equals(action)) {
                    if (status >= 200 && status < 300) Notifs.addMyReply(ctx, conv, text);
                    else Notifs.render(ctx, conv, true, status == 0
                        ? "⚠️ Não enviada: sem internet. Toque em Responder para tentar de novo."
                        : "⚠️ Não enviada (erro " + status + "). Abra o app para enviar.");
                }
            } catch (Exception e) {
                if (ACTION_REPLY.equals(action)) Notifs.render(ctx, conv, true, "⚠️ Não enviada. Abra o app para enviar.");
            } finally {
                pending.finish();
            }
        }).start();
    }

    /** POST JSON; devolve o status HTTP (0 = sem conexão) */
    static int post(String url, JSONObject body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = c.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = c.getResponseCode();
            try (InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream()) {
                if (in != null) while (in.read() != -1) { /* esvazia */ }
            }
            return code;
        } catch (Exception e) {
            return 0;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
