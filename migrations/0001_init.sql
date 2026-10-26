CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  pitfalls TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '未分類',
  related TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  due INTEGER NOT NULL,
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  elapsed_days INTEGER NOT NULL DEFAULT 0,
  scheduled_days INTEGER NOT NULL DEFAULT 0,
  learning_steps INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL DEFAULT 0,
  last_review INTEGER
);
CREATE INDEX cards_due ON cards (due);
CREATE INDEX cards_category ON cards (category);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  rating INTEGER NOT NULL,
  response TEXT NOT NULL DEFAULT '',
  reviewed_at INTEGER NOT NULL
);
CREATE INDEX reviews_reviewed_at ON reviews (reviewed_at);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
