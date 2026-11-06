package app.zap.chat;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.drawable.IconCompat;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** Monta as notificações no estilo do WhatsApp. */
final class Notifs {
    private Notifs() {}

    static final String CH_MESSAGES = "messages";
    static final String CH_CALLS = "calls";
    static final String CH_MESH = "mesh";
    static final String CH_MESH_SERVICE = "mesh_service";

    static final int ID_MESSAGE = 1;
    static final int ID_CALL = 2;
    static final int ID_MISSED = 3;
    static final int ID_MESH = 4;
    static final int ID_MESH_SERVICE = 5;

    static final String KEY_REPLY = "reply_text";
    static final int ACCENT = 0xFF5B6ABF;

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel msgs = new NotificationChannel(CH_MESSAGES, "Mensagens", NotificationManager.IMPORTANCE_HIGH);
        msgs.setDescription("Novas mensagens e ligações perdidas");
        msgs.enableVibration(true);
        msgs.setShowBadge(true);
        nm.createNotificationChannel(msgs);

        NotificationChannel calls = new NotificationChannel(CH_CALLS, "Ligações", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Ligações recebidas (toca até atender)");
        Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        calls.setSound(ring, new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] {0, 800, 600, 800, 600, 800});
        nm.createNotificationChannel(calls);

        NotificationChannel mesh = new NotificationChannel(CH_MESH, "Mensagens de emergência", NotificationManager.IMPORTANCE_HIGH);
        mesh.setDescription("Mensagens recebidas sem internet (Bluetooth/Wi-Fi)");
        nm.createNotificationChannel(mesh);

        NotificationChannel svc = new NotificationChannel(CH_MESH_SERVICE, "Modo emergência ativo", NotificationManager.IMPORTANCE_LOW);
        svc.setDescription("Aviso fixo enquanto o modo emergência procura aparelhos por perto");
        svc.setShowBadge(false);
        nm.createNotificationChannel(svc);
    }

    static boolean canNotify(Context ctx) {
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled();
    }

    @SuppressLint("MissingPermission")
    static void post(Context ctx, String tag, int id, NotificationCompat.Builder b) {
        if (!canNotify(ctx)) return;
        NotificationManagerCompat.from(ctx).notify(tag, id, b.build());
    }

    static void cancel(Context ctx, String tag, int id) {
        NotificationManagerCompat.from(ctx).cancel(tag, id);
    }

    // ------------------------------------------------------------------ intents
    static PendingIntent openApp(Context ctx, String conversationId, String callId, String action, int req) {
        Intent i = new Intent(ctx, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (conversationId != null) i.putExtra("conversationId", conversationId);
        if (callId != null) i.putExtra("callId", callId);
        if (action != null) i.putExtra("action", action);
        return PendingIntent.getActivity(ctx, req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static PendingIntent broadcast(Context ctx, String action, String conversationId, String callId, int req, boolean mutable) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(action);
        if (conversationId != null) i.putExtra("conversationId", conversationId);
        if (callId != null) i.putExtra("callId", callId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (mutable && Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : PendingIntent.FLAG_IMMUTABLE);
        return PendingIntent.getBroadcast(ctx, req, i, flags);
    }

    private static int req(String key, int n) {
        return (key == null ? 0 : key.hashCode()) * 31 + n;
    }

    // ------------------------------------------------------------------ mensagens
    /** histórico curto por conversa: a notificação mostra as últimas mensagens, como no WhatsApp */
    private static SharedPreferences history(Context ctx) {
        return ctx.getSharedPreferences("zap_notif_history", Context.MODE_PRIVATE);
    }

    static synchronized JSONArray loadHistory(Context ctx, String conv) {
        try {
            return new JSONArray(history(ctx).getString(conv, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static synchronized void saveHistory(Context ctx, String conv, JSONArray arr) {
        history(ctx).edit().putString(conv, arr.toString()).apply();
    }

    static synchronized void clearConversation(Context ctx, String conv) {
        history(ctx).edit().remove(conv).apply();
        cancel(ctx, conv, ID_MESSAGE);
        cancel(ctx, "missed-" + conv, ID_MISSED);
    }

    static void showMessage(Context ctx, Map<String, String> d) {
        String conv = d.get("conversationId");
        if (conv == null) return;
        try {
            JSONArray h = loadHistory(ctx, conv);
            String msgId = d.get("messageId");
            for (int i = 0; i < h.length(); i++) {
                if (msgId != null && msgId.equals(h.getJSONObject(i).optString("id"))) return; // já mostrada
            }
            JSONObject item = new JSONObject();
            item.put("id", msgId == null ? "" : msgId);
            item.put("sender", nz(d.get("sender"), nz(d.get("title"), "Zap")));
            item.put("text", nz(d.get("text"), nz(d.get("line"), "Nova mensagem")));
            item.put("ts", parseLong(d.get("ts"), System.currentTimeMillis()));
            item.put("icon", nz(d.get("senderIcon"), ""));
            h.put(item);
            while (h.length() > 8) h.remove(0);
            saveHistory(ctx, conv, h);

            JSONObject meta = new JSONObject();
            meta.put("title", nz(d.get("title"), "Zap"));
            meta.put("group", "true".equals(d.get("isGroup")));
            meta.put("icon", nz(d.get("icon"), ""));
            history(ctx).edit().putString("meta-" + conv, meta.toString()).apply();

            render(ctx, conv, false, null);
        } catch (Exception ignored) {
            // notificação nunca pode derrubar o app
        }
    }

    /** acrescenta a resposta enviada pela própria notificação ("Você: ...") */
    static void addMyReply(Context ctx, String conv, String text) {
        try {
            JSONArray h = loadHistory(ctx, conv);
            JSONObject item = new JSONObject();
            item.put("me", true);
            item.put("text", text);
            item.put("ts", System.currentTimeMillis());
            h.put(item);
            while (h.length() > 8) h.remove(0);
            saveHistory(ctx, conv, h);
            render(ctx, conv, true, null);
        } catch (Exception ignored) {
        }
    }

    /** redesenha a notificação da conversa (silenciosa = sem tocar de novo) */
    static void render(Context ctx, String conv, boolean silent, String warning) {
        try {
            JSONArray h = loadHistory(ctx, conv);
            if (h.length() == 0) return;
            JSONObject meta = new JSONObject(history(ctx).getString("meta-" + conv, "{}"));
            boolean group = meta.optBoolean("group", false);
            String title = meta.optString("title", "Zap");

            Person me = new Person.Builder().setName("Você").setKey("me").build();
            NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me);
            if (group) {
                style.setConversationTitle(title);
                style.setGroupConversation(true);
            }
            int unread = 0;
            for (int i = 0; i < h.length(); i++) {
                JSONObject it = h.getJSONObject(i);
                if (it.optBoolean("me", false)) {
                    style.addMessage(it.optString("text"), it.optLong("ts"), (Person) null);
                } else {
                    unread++;
                    String name = it.optString("sender", "Zap");
                    style.addMessage(it.optString("text"), it.optLong("ts"),
                        new Person.Builder().setName(name).setKey(name).build());
                }
            }
            if (warning != null) style.addMessage(warning, System.currentTimeMillis(), new Person.Builder().setName("Zap").setKey("zap").build());

            RemoteInput input = new RemoteInput.Builder(KEY_REPLY).setLabel("Responder").build();
            NotificationCompat.Action reply = new NotificationCompat.Action.Builder(
                R.drawable.ic_stat_zap, "Responder", broadcast(ctx, ActionReceiver.ACTION_REPLY, conv, null, req(conv, 1), true))
                .addRemoteInput(input)
                .setAllowGeneratedReplies(true)
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                .setShowsUserInterface(false)
                .build();
            NotificationCompat.Action read = new NotificationCompat.Action.Builder(
                R.drawable.ic_stat_zap, "Marcar como lida", broadcast(ctx, ActionReceiver.ACTION_READ, conv, null, req(conv, 2), false))
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
                .setShowsUserInterface(false)
                .build();

            NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CH_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat_zap)
                .setColor(ACCENT)
                .setStyle(style)
                .setContentTitle(title)
                .setContentIntent(openApp(ctx, conv, null, null, req(conv, 3)))
                .setDeleteIntent(broadcast(ctx, ActionReceiver.ACTION_DISMISS, conv, null, req(conv, 4), false))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setOnlyAlertOnce(silent)
                .setNumber(unread)
                .addAction(reply)
                .addAction(read);
            Bitmap avatar = loadAvatar(meta.optString("icon", ""));
            if (avatar != null) b.setLargeIcon(avatar);
            post(ctx, conv, ID_MESSAGE, b);
        } catch (Exception ignored) {
        }
    }

    // ------------------------------------------------------------------ ligações
    static void showCall(Context ctx, Map<String, String> d) {
        String callId = d.get("callId");
        String conv = d.get("conversationId");
        if (callId == null) return;
        String name = nz(d.get("title"), "Zap");
        boolean video = "true".equals(d.get("video"));

        Person.Builder pb = new Person.Builder().setName(name).setImportant(true);
        Bitmap avatar = loadAvatar(d.get("icon"));
        if (avatar != null) pb.setIcon(IconCompat.createWithBitmap(avatar));
        Person caller = pb.build();

        PendingIntent open = openApp(ctx, conv, callId, null, req(callId, 1));
        PendingIntent answer = openApp(ctx, conv, callId, "answer", req(callId, 2));
        PendingIntent decline = broadcast(ctx, ActionReceiver.ACTION_DECLINE, conv, callId, req(callId, 3), false);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CH_CALLS)
            .setSmallIcon(R.drawable.ic_stat_zap)
            .setColor(ACCENT)
            .setContentTitle(name)
            .setContentText(video ? "Chamada de vídeo do Zap" : "Chamada de voz do Zap")
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer).setIsVideo(video))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setContentIntent(open)
            .setFullScreenIntent(open, true) // tela bloqueada: abre a tela de chamada, como o WhatsApp
            .setOngoing(true)
            .setAutoCancel(true)
            .setTimeoutAfter(45_000)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), android.media.AudioManager.STREAM_RING);
        if (!canNotify(ctx)) return;
        android.app.Notification n = b.build();
        n.flags |= android.app.Notification.FLAG_INSISTENT; // toca sem parar até atender/recusar
        notifyRaw(ctx, "call-" + callId, ID_CALL, n);
    }

    @SuppressLint("MissingPermission")
    private static void notifyRaw(Context ctx, String tag, int id, android.app.Notification n) {
        NotificationManagerCompat.from(ctx).notify(tag, id, n);
    }

    static void cancelCall(Context ctx, String callId) {
        if (callId != null) cancel(ctx, "call-" + callId, ID_CALL);
    }

    static void showMissed(Context ctx, Map<String, String> d) {
        cancelCall(ctx, d.get("callId"));
        String conv = d.get("conversationId");
        String tag = "missed-" + conv;
        SharedPreferences p = history(ctx);
        int count = p.getInt(tag, 0) + 1;
        p.edit().putInt(tag, count).apply();
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_zap)
            .setColor(ACCENT)
            .setContentTitle(nz(d.get("title"), "Zap"))
            .setContentText(count > 1 ? count + " chamadas perdidas" : nz(d.get("line"), "Chamada perdida"))
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setContentIntent(openApp(ctx, conv, null, null, req(tag, 1)))
            .setDeleteIntent(broadcast(ctx, ActionReceiver.ACTION_DISMISS, conv, null, req(tag, 2), false))
            .setAutoCancel(true);
        Bitmap avatar = loadAvatar(d.get("icon"));
        if (avatar != null) b.setLargeIcon(avatar);
        post(ctx, tag, ID_MISSED, b);
    }

    static void resetMissed(Context ctx, String conv) {
        history(ctx).edit().remove("missed-" + conv).apply();
    }

    // ------------------------------------------------------------------ modo emergência
    static void showMesh(Context ctx, String title, String text) {
        Intent i = new Intent(ctx, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra("mesh", true);
        PendingIntent open = PendingIntent.getActivity(ctx, 777, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CH_MESH)
            .setSmallIcon(R.drawable.ic_stat_zap)
            .setColor(0xFFD64545)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .setAutoCancel(true);
        post(ctx, "mesh", ID_MESH, b);
    }

    // ------------------------------------------------------------------ util
    /** foto da pessoa (círculo) — com tempo limite curto, para não atrasar a notificação */
    static Bitmap loadAvatar(String url) {
        if (url == null || url.isEmpty() || !url.startsWith("http")) return null;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(4000);
            c.setReadTimeout(4000);
            try (InputStream in = c.getInputStream()) {
                Bitmap src = BitmapFactory.decodeStream(in);
                if (src == null) return null;
                int size = Math.min(src.getWidth(), src.getHeight());
                Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
                Canvas canvas = new Canvas(out);
                Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
                canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint);
                paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
                int x = (src.getWidth() - size) / 2;
                int y = (src.getHeight() - size) / 2;
                canvas.drawBitmap(src, new Rect(x, y, x + size, y + size), new Rect(0, 0, size, size), paint);
                return out;
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static String nz(String s, String fallback) {
        return s == null || s.isEmpty() ? fallback : s;
    }

    static long parseLong(String s, long fallback) {
        try {
            return Long.parseLong(s);
        } catch (Exception e) {
            return fallback;
        }
    }
}
