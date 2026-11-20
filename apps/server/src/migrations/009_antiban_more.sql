-- customer asked to stop ("הסר"/"stop"): no automatic or staff messages until they write again
ALTER TABLE contacts ADD COLUMN opted_out boolean NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN opted_out_at timestamptz;
-- manual / automatic emergency pause of all outbound traffic of a channel
ALTER TABLE channels ADD COLUMN paused boolean NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN paused_at timestamptz;
-- read receipts are sent once per inbound message, when staff open the conversation
ALTER TABLE messages ADD COLUMN read_sent boolean NOT NULL DEFAULT false;
