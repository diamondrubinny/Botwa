package net.rubinny.botwa;

import android.net.Uri;

import com.google.androidbrowserhelper.trusted.LauncherActivity;

/** Opens the panel at the address the user saved (deep links from alerts keep their own path). */
public class MainActivity extends LauncherActivity {
    @Override
    protected Uri getLaunchingUrl() {
        Uri incoming = getIntent() != null ? getIntent().getData() : null;
        String saved = Prefs.url(this);
        if (incoming != null && saved != null && Uri.parse(saved).getHost() != null && Uri.parse(saved).getHost().equals(incoming.getHost())) return incoming;
        return Uri.parse(saved != null ? saved : getString(R.string.default_url));
    }
}
