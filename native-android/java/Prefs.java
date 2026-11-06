package app.zap.chat;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;

/** Dados que o app (parte web) passa para a parte nativa: servidor, segredo do aparelho, contatos. */
final class Prefs {
    private Prefs() {}

    static SharedPreferences get(Context ctx) {
        return ctx.getSharedPreferences("zap", Context.MODE_PRIVATE);
    }

    static String apiBase(Context ctx) {
        return get(ctx).getString("apiBase", "https://chat-rho-drab.vercel.app");
    }

    static String secret(Context ctx) {
        return get(ctx).getString("secret", null);
    }

    static String userId(Context ctx) {
        return get(ctx).getString("userId", null);
    }

    /** nome de um contato (para "Mensagem de emergência de Fulano" mesmo sem internet) */
    static String contactName(Context ctx, String userId) {
        if (userId == null) return "Alguém";
        try {
            JSONObject c = new JSONObject(get(ctx).getString("contacts", "{}"));
            String n = c.optString(userId, "");
            return n.isEmpty() ? "Alguém" : n;
        } catch (Exception e) {
            return "Alguém";
        }
    }
}
