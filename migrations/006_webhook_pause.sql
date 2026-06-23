-- Sprint 6: pause/resume support for webhooks.
-- NULL = active; timestamp = paused at that moment.
ALTER TABLE webhooks ADD COLUMN paused_at TEXT;
