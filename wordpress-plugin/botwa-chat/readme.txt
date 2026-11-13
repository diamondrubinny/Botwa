=== Botwa Chat ===
Contributors: botwa
Tags: chat, live chat, support, widget, whatsapp
Requires at least: 5.8
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.0.1
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Adds your self-hosted Botwa website chat to WordPress.

== Description ==

Botwa Chat connects this site to a Botwa server you run yourself. Visitors get a chat button; conversations arrive in your Botwa inbox together with WhatsApp and Telegram, and your bot, flow chart and knowledge base answer them.

* One setting: server address and site key, with a connection test that also checks that this site is allowed in Botwa.
* Show on all pages, only the home page, or hide on chosen paths. Hidden from logged-in administrators by default.
* Optional: recognize logged-in customers, so the same person sees the same conversation on every device. The signature is computed on your server, the secret never reaches the browser.
* A "chat with us" button: shortcode `[botwa_chat_button]`, any link to `#botwa-chat`, or any element with the class `botwa-open`.
* Consent mode: load nothing until your consent tool calls `botwaChatLoad()`.
* Hebrew and RTL ready.

The chat runs in an isolated frame served by your Botwa server; this plugin only adds a small loader script. No data is sent to any third party.

== Installation ==

1. Upload the plugin and activate it.
2. In Botwa create a "website chat" channel, add this site to its allowed sites and copy the site key (`wc_...`) from the embed code.
3. Settings > Botwa Chat: enter the server address and the site key, tick "Enabled", press "Test connection", save.

== Frequently Asked Questions ==

= The button does not appear. =
Press "Test connection". The usual cause is that this site's address is not in the allowed sites of the chat in Botwa (check both with and without www), or the channel is not started in Botwa.

= Does it work with caching plugins? =
Yes. The tag carries attributes that ask optimisation plugins to leave it alone, and customer recognition is fetched in a separate no-cache request.

= Is the site key secret? =
No. It is in your page source by design. Who may show the chat is controlled by the allowed sites list in Botwa.

== Privacy ==

The plugin adds suggested text to Settings > Privacy. When a visitor opens the chat, their browser connects to your Botwa server and stores a random identifier for the conversation. Review the wording for your jurisdiction.

== Changelog ==

= 1.0.1 =
* Clearer connection test: says which field is wrong, accepts the key or server pasted with quotes, invisible direction marks, the data-key attribute or the whole embed code, and recognises a webhook secret or API key pasted by mistake.

= 1.0.0 =
* First release.
