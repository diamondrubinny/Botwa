-- E-mail as a channel (a support mailbox over IMAP/SMTP). Credentials live in the encrypted channel session store.
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('whatsapp', 'whatsapp_cloud', 'telegram', 'webchat', 'messenger', 'instagram', 'email'));
