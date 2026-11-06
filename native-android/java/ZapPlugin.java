package app.zap.chat;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;

/** Ponte JavaScript ⇄ Android ("Zap" no lado web: src/lib/native.ts). */
@CapacitorPlugin(
    name = "Zap",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "bluetooth", strings = {
            Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT }),
        @Permission(alias = "nearbyWifi", strings = { Manifest.permission.NEARBY_WIFI_DEVICES }),
    }
)
public class ZapPlugin extends Plugin {

    private static ZapPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    // ------------------------------------------------------------------ eventos para o JS
    /** toque numa notificação: abre a conversa / ligação / modo emergência */
    static void handleIntent(Intent intent) {
        if (intent == null) return;
        String conv = intent.getStringExtra("conversationId");
        String call = intent.getStringExtra("callId");
        boolean mesh = intent.getBooleanExtra("mesh", false);
        if (conv == null && call == null && !mesh) return;
        JSObject d = new JSObject();
        d.put("conversationId", conv);
        d.put("callId", call);
        d.put("action", intent.getStringExtra("action"));
        d.put("mesh", mesh);
        intent.removeExtra("conversationId");
        intent.removeExtra("callId");
        intent.removeExtra("mesh");
        intent.removeExtra("action");
        if (call != null && instance != null) Notifs.cancelCall(instance.getContext(), call);
        // retain=true: se o JS ainda não carregou, o evento espera ele chegar
        if (instance != null) instance.notifyListeners("notificationOpen", d, true);
    }

    static void emitToken(String token) {
        if (instance == null) return;
        JSObject d = new JSObject();
        d.put("token", token);
        instance.notifyListeners("pushToken", d, true);
    }

    static void emitMesh() {
        if (instance == null) return;
        instance.notifyListeners("meshChanged", status(), false);
    }

    private static JSObject status() {
        JSObject d = new JSObject();
        d.put("running", MeshService.running);
        d.put("peers", MeshService.peers);
        if (instance != null) {
            String me = Prefs.userId(instance.getContext());
            MeshStore s = MeshStore.get(instance.getContext());
            d.put("stored", s.size());
            d.put("carrying", me == null ? 0 : s.carrying(me));
        }
        return d;
    }

    // ------------------------------------------------------------------ sessão / notificações
    @PluginMethod
    public void setSession(PluginCall call) {
        Prefs.get(getContext()).edit()
            .putString("apiBase", call.getString("apiBase", Prefs.apiBase(getContext())))
            .putString("secret", call.getString("secret"))
            .putString("userId", call.getString("userId"))
            .apply();
        call.resolve();
    }

    @PluginMethod
    public void clearSession(PluginCall call) {
        Prefs.get(getContext()).edit().remove("secret").remove("userId").remove("contacts").apply();
        MeshService.stop(getContext());
        call.resolve();
    }

    /** nomes dos contatos, para as notificações do modo emergência funcionarem sem internet */
    @PluginMethod
    public void setContacts(PluginCall call) {
        JSObject c = call.getObject("contacts", new JSObject());
        Prefs.get(getContext()).edit().putString("contacts", c.toString()).apply();
        call.resolve();
    }

    @PluginMethod
    public void getPushToken(PluginCall call) {
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) {
                    JSObject r = new JSObject();
                    r.put("token", task.getResult());
                    call.resolve(r);
                } else {
                    call.reject("Firebase indisponível: " + (task.getException() == null ? "?" : task.getException().getMessage()));
                }
            });
        } catch (Exception e) {
            call.reject("Firebase não configurado neste APK (google-services.json)");
        }
    }

    @PluginMethod
    public void notificationPermission(PluginCall call) {
        JSObject r = new JSObject();
        r.put("state", Build.VERSION.SDK_INT >= 33 ? getPermissionState("notifications").toString() : "granted");
        r.put("enabled", Notifs.canNotify(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            notificationPermission(call);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionResult");
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        notificationPermission(call);
    }

    /** abriu a conversa no app: some a notificação dela */
    @PluginMethod
    public void clearNotifications(PluginCall call) {
        String conv = call.getString("conversationId");
        String callId = call.getString("callId");
        if (conv != null) {
            Notifs.clearConversation(getContext(), conv);
            Notifs.resetMissed(getContext(), conv);
        }
        if (callId != null) Notifs.cancelCall(getContext(), callId);
        if (call.getBoolean("mesh", false)) Notifs.cancel(getContext(), "mesh", Notifs.ID_MESH);
        call.resolve();
    }

    // ------------------------------------------------------------------ modo emergência
    private String[] meshAliases() {
        List<String> a = new ArrayList<>();
        a.add("location");
        if (Build.VERSION.SDK_INT >= 31) a.add("bluetooth");
        if (Build.VERSION.SDK_INT >= 33) a.add("nearbyWifi");
        return a.toArray(new String[0]);
    }

    private boolean meshGranted() {
        for (String alias : meshAliases()) {
            // a partir do Android 13 o Wi-Fi por perto substitui a localização
            if ("location".equals(alias) && Build.VERSION.SDK_INT >= 33) continue;
            if (getPermissionState(alias) != PermissionState.GRANTED) return false;
        }
        return true;
    }

    @PluginMethod
    public void meshStart(PluginCall call) {
        if (Prefs.userId(getContext()) == null) {
            call.reject("Entre na sua conta uma vez com internet antes de usar o modo emergência");
            return;
        }
        if (!meshGranted()) {
            requestPermissionForAliases(meshAliases(), call, "meshPermissionResult");
            return;
        }
        MeshService.start(getContext());
        call.resolve(status());
    }

    @PermissionCallback
    private void meshPermissionResult(PluginCall call) {
        if (!meshGranted()) {
            call.reject("Sem permissão de Bluetooth/Wi-Fi/Localização, o modo emergência não consegue achar outros celulares");
            return;
        }
        MeshService.start(getContext());
        call.resolve(status());
    }

    @PluginMethod
    public void meshStop(PluginCall call) {
        MeshService.stop(getContext());
        call.resolve(status());
    }

    @PluginMethod
    public void meshStatus(PluginCall call) {
        call.resolve(status());
    }

    /** guarda um envelope escrito aqui e já espalha para os celulares conectados */
    @PluginMethod
    public void meshSend(PluginCall call) {
        String env = call.getString("envelope");
        boolean isNew = MeshStore.get(getContext()).put(env);
        if (isNew) MeshService.spread(env);
        JSObject r = status();
        r.put("stored", isNew);
        call.resolve(r);
    }

    /** guarda envelopes que vieram da internet (caixa postal) para também carregá-los */
    @PluginMethod
    public void meshAdd(PluginCall call) {
        JSArray list = call.getArray("envelopes", new JSArray());
        int added = 0;
        for (int i = 0; i < list.length(); i++) {
            String env = list.optString(i, null);
            if (env != null && MeshStore.get(getContext()).put(env)) {
                MeshService.spread(env);
                added++;
            }
        }
        JSObject r = status();
        r.put("added", added);
        call.resolve(r);
    }

    @PluginMethod
    public void meshInbox(PluginCall call) {
        String me = Prefs.userId(getContext());
        JSObject r = new JSObject();
        r.put("envelopes", me == null ? new JSArray() : toJs(MeshStore.get(getContext()).inbox(me)));
        call.resolve(r);
    }

    @PluginMethod
    public void meshConsume(PluginCall call) {
        MeshStore.get(getContext()).consume(strings(call.getArray("ids", new JSArray())));
        call.resolve();
    }

    @PluginMethod
    public void meshOutbox(PluginCall call) {
        String me = Prefs.userId(getContext());
        JSObject r = new JSObject();
        r.put("envelopes", me == null ? new JSArray() : toJs(MeshStore.get(getContext()).outbox(me)));
        call.resolve(r);
    }

    @PluginMethod
    public void meshMarkUploaded(PluginCall call) {
        MeshStore.get(getContext()).markUploaded(strings(call.getArray("ids", new JSArray())));
        call.resolve();
    }

    private static JSArray toJs(JSONArray a) {
        JSArray out = new JSArray();
        for (int i = 0; i < a.length(); i++) out.put(a.optString(i));
        return out;
    }

    private static List<String> strings(JSArray a) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) {
            String s = a.optString(i, null);
            if (s != null) out.add(s);
        }
        return out;
    }
}
