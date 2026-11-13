CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  sender TEXT,
  recipient TEXT,
  sim_number INTEGER,
  message TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_received ON messages (received_at DESC);
