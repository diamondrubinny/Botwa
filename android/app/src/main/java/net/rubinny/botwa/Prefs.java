package net.rubinny.botwa;

import android.content.Context;
import android.net.Uri;

/** The server address, kept on the phone only. */
final class Prefs {
    private static final String FILE = "botwa";
    private static final String KEY = "server_url";
    private Prefs() {}

    static String url(Context c) { return c.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, null); }
    static void save(Context c, String url) { c.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY, url).apply(); }

    /** https only, a real host, no user info; returns the normalised address or null. */
    static String normalise(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (!s.contains("://")) s = "https://" + s;
        Uri u = Uri.parse(s);
        if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getHost().isEmpty() || u.getUserInfo() != null) return null;
        String path = u.getPath() == null || u.getPath().isEmpty() ? "/" : u.getPath();
        if (!path.endsWith("/")) path = path + "/";
        return "https://" + u.getHost().toLowerCase() + (u.getPort() > 0 ? ":" + u.getPort() : "") + path;
    }
}
