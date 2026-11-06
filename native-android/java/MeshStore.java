package app.zap.chat;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * "Mochila" de mensagens do modo emergência.
 * Guarda os envelopes (criptografados) que este celular carrega — próprios e de outras pessoas —
 * para entregar quando encontrar o destinatário, outro celular com o Zap ou internet.
 * O conteúdo é opaco aqui: só o aparelho do destinatário consegue abrir.
 */
final class MeshStore {
    static final int MAX = 2000;
    static final int MAX_ENVELOPE_BYTES = 24_000;

    private static MeshStore instance;

    static synchronized MeshStore get(Context ctx) {
        if (instance == null) instance = new MeshStore(ctx.getApplicationContext());
        return instance;
    }

    private static final class Entry {
        String env;
        String to;
        String from;
        String kind;
        long exp;
        long at;
        boolean uploaded;
        boolean consumed;
    }

    private final File file;
    private final LinkedHashMap<String, Entry> items = new LinkedHashMap<>();

    private MeshStore(Context ctx) {
        file = new File(ctx.getFilesDir(), "mesh-store.json");
        load();
    }

    /** guarda um envelope novo; devolve false se já tinha, se expirou ou se é inválido */
    synchronized boolean put(String env) {
        if (env == null || env.length() > MAX_ENVELOPE_BYTES) return false;
        try {
            JSONObject o = new JSONObject(env);
            String id = o.optString("id", "");
            String to = o.optString("to", "");
            long exp = o.optLong("exp", 0);
            if (id.isEmpty() || id.length() > 80 || to.isEmpty()) return false;
            if (items.containsKey(id) || exp < System.currentTimeMillis()) return false;
            Entry e = new Entry();
            e.env = env;
            e.to = to;
            e.from = o.optString("from", "");
            e.kind = o.optString("t", "m");
            e.exp = exp;
            e.at = System.currentTimeMillis();
            items.put(id, e);
            prune();
            save();
            return true;
        } catch (Exception ex) {
            return false;
        }
    }

    synchronized boolean has(String id) {
        return items.containsKey(id);
    }

    synchronized String envelope(String id) {
        Entry e = items.get(id);
        return e == null ? null : e.env;
    }

    synchronized List<String> ids() {
        prune();
        return new ArrayList<>(items.keySet());
    }

    synchronized int size() {
        return items.size();
    }

    /** quantos envelopes de OUTRAS pessoas este celular está carregando */
    synchronized int carrying(String me) {
        int n = 0;
        for (Entry e : items.values()) if (!e.to.equals(me) && !e.from.equals(me)) n++;
        return n;
    }

    /** envelopes endereçados a mim que o app ainda não leu */
    synchronized JSONArray inbox(String me) {
        JSONArray out = new JSONArray();
        for (Entry e : items.values()) if (e.to.equals(me) && !e.consumed) out.put(e.env);
        return out;
    }

    synchronized void consume(List<String> ids) {
        for (String id : ids) {
            Entry e = items.get(id);
            if (e != null) e.consumed = true;
        }
        save();
    }

    /** envelopes para depositar na caixa postal quando houver internet */
    synchronized JSONArray outbox(String me) {
        JSONArray out = new JSONArray();
        for (Entry e : items.values()) if (!e.uploaded && !e.to.equals(me)) out.put(e.env);
        return out;
    }

    synchronized void markUploaded(List<String> ids) {
        for (String id : ids) {
            Entry e = items.get(id);
            if (e != null) e.uploaded = true;
        }
        save();
    }

    /** tira os vencidos e, se passar do limite, os mais antigos (mantém os próprios por último) */
    private void prune() {
        long now = System.currentTimeMillis();
        Iterator<Map.Entry<String, Entry>> it = items.entrySet().iterator();
        while (it.hasNext()) if (it.next().getValue().exp < now) it.remove();
        it = items.entrySet().iterator();
        while (items.size() > MAX && it.hasNext()) {
            it.next();
            it.remove();
        }
    }

    private void load() {
        try {
            if (!file.exists()) return;
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
                byte[] chunk = new byte[8192];
                int n;
                while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            }
            JSONArray arr = new JSONArray(new String(buf.toByteArray(), StandardCharsets.UTF_8));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Entry e = new Entry();
                e.env = o.getString("env");
                e.to = o.optString("to");
                e.from = o.optString("from");
                e.kind = o.optString("kind", "m");
                e.exp = o.optLong("exp");
                e.at = o.optLong("at");
                e.uploaded = o.optBoolean("up");
                e.consumed = o.optBoolean("cons");
                items.put(o.getString("id"), e);
            }
            prune();
        } catch (Exception ignored) {
            items.clear();
        }
    }

    private void save() {
        try {
            JSONArray arr = new JSONArray();
            for (Map.Entry<String, Entry> me : items.entrySet()) {
                Entry e = me.getValue();
                JSONObject o = new JSONObject();
                o.put("id", me.getKey());
                o.put("env", e.env);
                o.put("to", e.to);
                o.put("from", e.from);
                o.put("kind", e.kind);
                o.put("exp", e.exp);
                o.put("at", e.at);
                o.put("up", e.uploaded);
                o.put("cons", e.consumed);
                arr.put(o);
            }
            File tmp = new File(file.getPath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(arr.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (!tmp.renameTo(file)) {
                file.delete();
                tmp.renameTo(file);
            }
        } catch (Exception ignored) {
        }
    }
}
