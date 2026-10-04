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

-- A college team is one school's program in one sport. Coaches post on its behalf.
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school TEXT NOT NULL,
  sport TEXT NOT NULL,
  division TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_school_sport ON teams(school COLLATE NOCASE, sport);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caption TEXT,
  media_filename TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_team ON posts(team_id);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS team_follows (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  athlete_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, athlete_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_athlete ON team_follows(athlete_id);

-- Open times on a coach's visit calendar. Times are campus-local, stored as "YYYY-MM-DDTHH:MM".
CREATE TABLE IF NOT EXISTS visit_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,
  location TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_slots_coach ON visit_slots(coach_id, starts_at);

-- People following people (athletes and coaches).
CREATE TABLE IF NOT EXISTS user_follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id != followee_id)
);
CREATE INDEX IF NOT EXISTS idx_user_follows_followee ON user_follows(followee_id);

-- A direct-message thread between an athlete and either one coach or a whole team.
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  athlete_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((coach_id IS NULL) != (team_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_athlete_coach ON conversations(athlete_id, coach_id) WHERE coach_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_athlete_team ON conversations(athlete_id, team_id) WHERE team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

-- The last message each participant has seen, for unread counts.
CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
`;

// Columns added after the first release; ALTER TABLE brings older databases up to date.
const ADDED_COLUMNS = {
  athlete_profiles: {
    athlete_code: 'TEXT',
    position_rank: 'INTEGER',
    star_rating: 'INTEGER CHECK (star_rating BETWEEN 1 AND 5)',
    national_rank: 'INTEGER',
  },
  visit_requests: {
    slot_id: 'INTEGER REFERENCES visit_slots(id) ON DELETE SET NULL',
  },
  coach_profiles: {
    team_id: 'INTEGER REFERENCES teams(id) ON DELETE SET NULL',
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

  // Coaches who filled in school and sport before teams existed get linked to their team.
  const unlinked = db
    .prepare('SELECT user_id, school, sport, division FROM coach_profiles WHERE team_id IS NULL AND school IS NOT NULL AND sport IS NOT NULL')
    .all();
  for (const c of unlinked) {
    db.prepare('UPDATE coach_profiles SET team_id = ? WHERE user_id = ?').run(findOrCreateTeam(db, c), c.user_id);
  }
}

// Returns the id of the team for this school and sport, creating it if needed.
function findOrCreateTeam(db, { school, sport, division }) {
  const existing = db.prepare('SELECT id FROM teams WHERE school = ? COLLATE NOCASE AND sport = ?').get(school, sport);
  if (existing) {
    if (division) db.prepare('UPDATE teams SET division = ? WHERE id = ?').run(division, existing.id);
    return existing.id;
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO teams (school, sport, division) VALUES (?, ?, ?)')
    .run(school, sport, division || null);
  return Number(lastInsertRowid);
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

module.exports = { openDatabase, findOrCreateTeam };
