-- Official WhatsApp Business Platform (Cloud API) channel type. Its credentials live in the encrypted channel session store.
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('whatsapp', 'whatsapp_cloud', 'telegram'));
