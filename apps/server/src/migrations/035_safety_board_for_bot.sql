-- The unit asked for the bot to answer from the SafetyBoard: rows imported earlier as "staff only" (the old default) become
-- visible to the bot too. The content is published regulations and published answers. Revert in Safety > Manage the board.
UPDATE kb_sources SET audience = 'both' WHERE origin LIKE 'xlsx:%' AND audience = 'staff';
