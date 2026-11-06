package app.zap.chat;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Modo emergência: conversa com celulares próximos que tenham o Zap, SEM internet,
 * por Bluetooth e Wi-Fi Direct (Google Nearby Connections, em malha).
 *
 * Protocolo entre dois celulares que se encontram:
 *   1. cada um manda a lista dos ids que carrega   {"t":"sum","ids":[...]}
 *   2. cada um pede o que não tem                    {"t":"want","ids":[...]}
 *   3. os envelopes pedidos vão um a um              {"t":"env","e":"<envelope>"}
 * Envelope novo (escrito aqui ou recebido) é repassado na hora a todos os conectados ("inundação").
 * Assim a mensagem pula de celular em celular e também viaja no bolso de quem se desloca ("leva e entrega").
 */
public class MeshService extends Service {

    static final String SERVICE_ID = "app.zap.chat.mesh";
    static final String ACTION_STOP = "app.zap.chat.MESH_STOP";
    private static final String TAG = "ZapMesh";
    private static final int CHUNK = 300;

    static volatile boolean running = false;
    static volatile int peers = 0;
    private static MeshService instance;

    private ConnectionsClient client;
    private String myName;
    private String myUserId;
    private final Set<String> connected = ConcurrentHashMap.newKeySet();
    private final Set<String> pending = ConcurrentHashMap.newKeySet();
    private final Handler handler = new Handler(Looper.getMainLooper());

    static void start(Context ctx) {
        ContextCompat.startForegroundService(ctx, new Intent(ctx, MeshService.class));
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, MeshService.class));
    }

    /** envelope escrito neste celular: espalha para quem estiver conectado agora */
    static void spread(String envelope) {
        MeshService s = instance;
        if (s != null) s.forward(envelope, null);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        client = Nearby.getConnectionsClient(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        Notifs.ensureChannels(this);
        ServiceCompat.startForeground(this, Notifs.ID_MESH_SERVICE, buildNotification(),
            Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE : 0);
        if (!running) begin();
        return START_STICKY;
    }

    private void begin() {
        myUserId = Prefs.userId(this);
        if (myUserId == null) {
            stopSelf();
            return;
        }
        String suffix = Prefs.get(this).getString("meshSuffix", null);
        if (suffix == null) {
            suffix = UUID.randomUUID().toString().substring(0, 6);
            Prefs.get(this).edit().putString("meshSuffix", suffix).apply();
        }
        myName = myUserId + ":" + suffix; // mesmo usuário com dois celulares = nomes diferentes
        running = true;
        startRadio();
        // a busca do Nearby às vezes "adormece": reinicia de tempos em tempos
        handler.postDelayed(restarter, 120_000);
        ZapPlugin.emitMesh();
    }

    private final Runnable restarter = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            client.stopDiscovery();
            client.startDiscovery(SERVICE_ID, discovery,
                new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build())
                .addOnFailureListener(e -> Log.w(TAG, "discovery", e));
            handler.postDelayed(this, 120_000);
        }
    };

    private void startRadio() {
        client.startAdvertising(myName, SERVICE_ID, lifecycle,
            new AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build())
            .addOnFailureListener(e -> Log.w(TAG, "advertising", e));
        client.startDiscovery(SERVICE_ID, discovery,
            new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build())
            .addOnFailureListener(e -> Log.w(TAG, "discovery", e));
    }

    @Override
    public void onDestroy() {
        running = false;
        peers = 0;
        handler.removeCallbacksAndMessages(null);
        try {
            client.stopAdvertising();
            client.stopDiscovery();
            client.stopAllEndpoints();
        } catch (Exception ignored) {
        }
        connected.clear();
        pending.clear();
        instance = null;
        ZapPlugin.emitMesh();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ------------------------------------------------------------------ conexões
    private void connect(String endpointId) {
        if (connected.contains(endpointId) || pending.contains(endpointId)) return;
        pending.add(endpointId);
        client.requestConnection(myName, endpointId, lifecycle).addOnFailureListener(e -> pending.remove(endpointId));
    }

    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
            if (!SERVICE_ID.equals(info.getServiceId())) return;
            // para os dois não pedirem conexão ao mesmo tempo, pede quem tem o "nome menor";
            // o outro só pede se nada acontecer em 12 s (caso só um lado tenha enxergado o outro)
            if (myName.compareTo(info.getEndpointName()) < 0) connect(endpointId);
            else handler.postDelayed(() -> connect(endpointId), 12_000);
        }

        @Override
        public void onEndpointLost(@NonNull String endpointId) {
            pending.remove(endpointId);
        }
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
            // malha aberta: o conteúdo é criptografado de ponta a ponta, então qualquer Zap pode carregar
            pending.add(endpointId);
            client.acceptConnection(endpointId, payloads);
        }

        @Override
        public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution result) {
            pending.remove(endpointId);
            if (result.getStatus().isSuccess()) {
                connected.add(endpointId);
                updatePeers();
                sendSummary(endpointId);
            }
        }

        @Override
        public void onDisconnected(@NonNull String endpointId) {
            connected.remove(endpointId);
            updatePeers();
        }
    };

    private final PayloadCallback payloads = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            if (payload.getType() != Payload.Type.BYTES || payload.asBytes() == null) return;
            try {
                handle(endpointId, new JSONObject(new String(payload.asBytes(), StandardCharsets.UTF_8)));
            } catch (Exception e) {
                Log.w(TAG, "payload inválido", e);
            }
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {}
    };

    // ------------------------------------------------------------------ troca de envelopes
    private void handle(String from, JSONObject m) throws Exception {
        MeshStore store = MeshStore.get(this);
        switch (m.optString("t")) {
            case "sum": {
                JSONArray ids = m.optJSONArray("ids");
                List<String> want = new ArrayList<>();
                for (int i = 0; ids != null && i < ids.length(); i++) {
                    String id = ids.optString(i);
                    if (!id.isEmpty() && !store.has(id)) want.add(id);
                }
                for (int i = 0; i < want.size(); i += CHUNK) {
                    JSONObject w = new JSONObject();
                    w.put("t", "want");
                    w.put("ids", new JSONArray(want.subList(i, Math.min(want.size(), i + CHUNK))));
                    send(from, w);
                }
                break;
            }
            case "want": {
                JSONArray ids = m.optJSONArray("ids");
                for (int i = 0; ids != null && i < ids.length(); i++) {
                    String env = store.envelope(ids.optString(i));
                    if (env != null) send(from, envMessage(env));
                }
                break;
            }
            case "env": {
                String env = m.optString("e", null);
                if (env != null && store.put(env)) received(env, from);
                break;
            }
            default:
                break;
        }
    }

    private void received(String env, String source) {
        try {
            JSONObject o = new JSONObject(env);
            if (myUserId != null && myUserId.equals(o.optString("to"))) {
                if ("m".equals(o.optString("t", "m"))) {
                    String name = Prefs.contactName(this, o.optString("from"));
                    if (!MainActivity.visible) Notifs.showMesh(this, "🆘 " + name, "Mensagem de emergência recebida sem internet. Toque para ler.");
                }
                ZapPlugin.emitMesh();
            }
        } catch (Exception ignored) {
        }
        forward(env, source);
        updatePeers();
    }

    private void forward(String env, String except) {
        try {
            JSONObject msg = envMessage(env);
            for (String id : connected) if (!id.equals(except)) send(id, msg);
        } catch (Exception ignored) {
        }
    }

    private static JSONObject envMessage(String env) throws Exception {
        JSONObject e = new JSONObject();
        e.put("t", "env");
        e.put("e", env);
        return e;
    }

    private void sendSummary(String endpointId) {
        try {
            List<String> ids = MeshStore.get(this).ids();
            if (ids.isEmpty()) {
                JSONObject s = new JSONObject();
                s.put("t", "sum");
                s.put("ids", new JSONArray());
                send(endpointId, s);
                return;
            }
            for (int i = 0; i < ids.size(); i += CHUNK) {
                JSONObject s = new JSONObject();
                s.put("t", "sum");
                s.put("ids", new JSONArray(ids.subList(i, Math.min(ids.size(), i + CHUNK))));
                send(endpointId, s);
            }
        } catch (Exception ignored) {
        }
    }

    private void send(String endpointId, JSONObject m) {
        byte[] bytes = m.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > ConnectionsClient.MAX_BYTES_DATA_SIZE) return;
        client.sendPayload(endpointId, Payload.fromBytes(bytes));
    }

    // ------------------------------------------------------------------ aviso fixo
    private void updatePeers() {
        peers = connected.size();
        if (running) {
            try {
                Notifs.post(this, null, Notifs.ID_MESH_SERVICE, builder());
            } catch (Exception ignored) {
            }
        }
        ZapPlugin.emitMesh();
    }

    private Notification buildNotification() {
        return builder().build();
    }

    private NotificationCompat.Builder builder() {
        int carrying = myUserId == null ? 0 : MeshStore.get(this).carrying(myUserId);
        String text = (peers == 0 ? "Procurando celulares com o Zap por perto…"
            : peers == 1 ? "1 celular conectado" : peers + " celulares conectados")
            + (carrying > 0 ? " · levando " + carrying + " mensagem(ns) de outras pessoas" : "");
        Intent open = new Intent(this, MainActivity.class).putExtra("mesh", true)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Intent stop = new Intent(this, MeshService.class).setAction(ACTION_STOP);
        return new NotificationCompat.Builder(this, Notifs.CH_MESH_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_zap)
            .setColor(0xFFD64545)
            .setContentTitle("🆘 Modo emergência ativo")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(PendingIntent.getActivity(this, 778, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
            .addAction(R.drawable.ic_stat_zap, "Desligar",
                PendingIntent.getService(this, 779, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    }
}
