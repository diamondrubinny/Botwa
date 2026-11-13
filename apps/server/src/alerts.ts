import type { Config } from './config.js';

/** Optional outbound notification (Slack/Teams/Discord/ntfy-style JSON webhook) when a channel needs attention. Never throws. */
export async function sendAlert(cfg: Config, text: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  const url = cfg.ALERT_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `text` is understood by Slack/Mattermost/Discord-compatible webhooks; extra fields help custom receivers
      body: JSON.stringify({ text, content: text, source: 'botwa', ...extra }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    return res.ok;
  } catch {
    return false;
  }
}
