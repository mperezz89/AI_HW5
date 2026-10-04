const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('athlete', 'coach')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS athlete_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  athlete_code TEXT,
  sport TEXT,
  position TEXT,
  position_rank INTEGER,
  star_rating INTEGER CHECK (star_rating BETWEEN 1 AND 5),
  national_rank INTEGER,
  grad_year INTEGER,
  high_school TEXT,
  city TEXT,
  state TEXT,
  height TEXT,
  weight TEXT,
  gpa TEXT,
  bio TEXT,
  phone TEXT
);

CREATE TABLE IF NOT EXISTS coach_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  school TEXT,
  title TEXT,
  sport TEXT,
  division TEXT
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  athlete_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  sport TEXT,
  opponent TEXT,
  game_date TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_videos_athlete ON videos(athlete_id);

CREATE TABLE IF NOT EXISTS visit_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  athlete_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  proposed_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  response_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_visits_athlete ON visit_requests(athlete_id);
CREATE INDEX IF NOT EXISTS idx_visits_coach ON visit_requests(coach_id);
`;

// Columns added after the first release; ALTER TABLE brings older databases up to date.
const ADDED_COLUMNS = {
  athlete_profiles: {
    athlete_code: 'TEXT',
    position_rank: 'INTEGER',
    star_rating: 'INTEGER CHECK (star_rating BETWEEN 1 AND 5)',
    national_rank: 'INTEGER',
  },
};

function migrate(db) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_athlete_code ON athlete_profiles(athlete_code COLLATE NOCASE) WHERE athlete_code IS NOT NULL'
  );
}

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

module.exports = { openDatabase };
