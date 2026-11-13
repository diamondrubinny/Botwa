-- Facebook Messenger (a Page) and Instagram business messaging, through Meta's Messenger Platform.
-- Credentials live in the encrypted channel session store, like the official WhatsApp channel.
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('whatsapp', 'whatsapp_cloud', 'telegram', 'webchat', 'messenger', 'instagram'));
