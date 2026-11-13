package net.rubinny.botwa;

import android.app.Activity;
import android.app.AlertDialog;
import android.net.Uri;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.Collections;

/**
 * Asks once for the panel address (prefilled), then opens the panel. Long-press the app icon,
 * "שינוי כתובת השרת", to change it later.
 */
public class SetupActivity extends Activity {
    static final String EXTRA_EDIT = "edit";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        addEditShortcut();
        boolean edit = getIntent() != null && getIntent().getBooleanExtra(EXTRA_EDIT, false);
        if (!edit && Prefs.url(this) != null) { checkThenOpen(); return; }
        setContentView(form());
    }

    /** Every 12 hours: is there a newer app? Ask once, then open the panel either way. */
    private void checkThenOpen() {
        if (!Updates.due(this)) { openPanel(); return; }
        new Thread(() -> {
            Updates.Info info = Updates.fetch(getString(R.string.update_url), BuildConfig.VERSION_CODE);
            Updates.checked(this);
            runOnUiThread(() -> {
                if (isFinishing()) return;
                if (info == null) { openPanel(); return; }
                new AlertDialog.Builder(this)
                    .setTitle("גרסה חדשה של האפליקציה")
                    .setMessage("גרסה " + info.name + " זמינה (מותקנת: " + BuildConfig.VERSION_NAME + "). העדכון יורד בדפדפן, ואז מאשרים התקנה. הנתונים וההתחברות נשמרים.")
                    .setPositiveButton("עדכון", (d, w) -> { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(info.apk))); finish(); })
                    .setNegativeButton("אחר כך", (d, w) -> openPanel())
                    .setOnCancelListener(d -> openPanel())
                    .show();
            });
        }).start();
    }

    private void openPanel() {
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    private View form() {
        int pad = dp(24);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        root.setPadding(pad, dp(48), pad, pad);

        TextView title = new TextView(this);
        title.setText(getString(R.string.app_name));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        title.setTextColor(0xFF141824);
        title.setAccessibilityHeading(Build.VERSION.SDK_INT >= 28);
        root.addView(title);

        TextView label = new TextView(this);
        label.setText("כתובת המערכת (לדוגמה https://support.example.com)");
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        label.setTextColor(0xFF4A5266);
        label.setPadding(0, dp(24), 0, dp(8));
        label.setId(View.generateViewId());
        root.addView(label);

        EditText url = new EditText(this);
        url.setId(View.generateViewId());
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        url.setTextDirection(View.TEXT_DIRECTION_LTR);
        url.setImeOptions(EditorInfo.IME_ACTION_GO);
        url.setMinHeight(dp(48));
        String saved = Prefs.url(this);
        url.setText(saved != null ? saved : getString(R.string.default_url));
        label.setLabelFor(url.getId());
        root.addView(url);

        TextView error = new TextView(this);
        error.setTextColor(0xFFB42318);
        error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        error.setPadding(0, dp(8), 0, dp(8));
        root.addView(error);

        Button go = new Button(this);
        go.setText("כניסה");
        go.setMinHeight(dp(48));
        go.setOnClickListener(v -> {
            String n = Prefs.normalise(url.getText().toString());
            if (n == null) { error.setText("נא לכתוב כתובת מלאה שמתחילה ב-https://"); url.requestFocus(); return; }
            Prefs.save(this, n);
            openPanel();
        });
        url.setOnEditorActionListener((v, actionId, e) -> { go.performClick(); return true; });
        root.addView(go, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        TextView hint = new TextView(this);
        hint.setText("הכתובת נשמרת בטלפון בלבד. כדי לשנות אותה בהמשך: לחיצה ארוכה על סמל האפליקציה ← \"שינוי כתובת השרת\".");
        hint.setTextColor(0xFF4A5266);
        hint.setPadding(0, dp(16), 0, 0);
        hint.setGravity(Gravity.START);
        root.addView(hint);
        return root;
    }

    private void addEditShortcut() {
        if (Build.VERSION.SDK_INT < 25) return;
        try {
            ShortcutManager sm = getSystemService(ShortcutManager.class);
            if (sm == null) return;
            Intent i = new Intent(this, SetupActivity.class).setAction(Intent.ACTION_VIEW).putExtra(EXTRA_EDIT, true);
            ShortcutInfo s = new ShortcutInfo.Builder(this, "server")
                .setShortLabel("שינוי כתובת השרת")
                .setIcon(Icon.createWithResource(this, R.mipmap.ic_launcher))
                .setIntent(i).build();
            sm.setDynamicShortcuts(Collections.singletonList(s));
        } catch (RuntimeException ignored) { /* launcher without shortcuts */ }
    }

    private int dp(int v) { return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics())); }
}
