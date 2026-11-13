package net.rubinny.botwa;

import android.content.Context;
import android.net.Uri;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Looks for a newer build of this app (version.json published next to the APK by the repository's build workflow).
 * At most every 12 hours, a few seconds at most, and only over https from GitHub. Installing is the user's choice:
 * the APK opens in the browser and Android checks it is signed with the same key before updating.
 */
final class Updates {
    static final class Info { final int code; final String name; final String apk; Info(int c, String n, String a) { code = c; name = n; apk = a; } }
    private static final long EVERY_MS = 12L * 3600 * 1000;
    private Updates() {}

    static boolean due(Context c) {
        long last = c.getSharedPreferences("botwa", Context.MODE_PRIVATE).getLong("update_checked", 0);
        return System.currentTimeMillis() - last > EVERY_MS;
    }
    static void checked(Context c) { c.getSharedPreferences("botwa", Context.MODE_PRIVATE).edit().putLong("update_checked", System.currentTimeMillis()).apply(); }

    private static boolean trusted(String url) {
        Uri u = Uri.parse(url);
        String h = u.getHost() == null ? "" : u.getHost().toLowerCase();
        return "https".equals(u.getScheme()) && (h.equals("github.com") || h.endsWith(".githubusercontent.com"));
    }

    /** The newer version, or null (none, not reachable, or anything unexpected). Call off the main thread. */
    static Info fetch(String url, int current) {
        if (url == null || url.isEmpty() || !trusted(url)) return null;
        HttpURLConnection con = null;
        try {
            String next = url;
            for (int hops = 0; hops < 4; hops++) {   // GitHub redirects release files to its download host
                con = (HttpURLConnection) new URL(next).openConnection();
                con.setInstanceFollowRedirects(false);
                con.setConnectTimeout(3000);
                con.setReadTimeout(3000);
                int code = con.getResponseCode();
                if (code >= 300 && code < 400) { next = con.getHeaderField("Location"); con.disconnect(); if (next == null || !trusted(next)) return null; continue; }
                if (code != 200) return null;
                try (InputStream in = con.getInputStream()) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[4096]; int n, total = 0;
                    while ((n = in.read(buf)) > 0) { total += n; if (total > 16384) return null; out.write(buf, 0, n); }
                    JSONObject j = new JSONObject(out.toString("UTF-8"));
                    int vc = j.getInt("versionCode");
                    String apk = j.getString("apk");
                    if (vc <= current || !trusted(apk)) return null;
                    return new Info(vc, j.optString("versionName", String.valueOf(vc)), apk);
                }
            }
            return null;
        } catch (Exception e) {
            return null;
        } finally {
            if (con != null) con.disconnect();
        }
    }
}
