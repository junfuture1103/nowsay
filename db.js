const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'nowsay.db');

// Ensure directory exists for the DB file
const fs = require('fs');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    text TEXT NOT NULL,
    nickname TEXT DEFAULT '익명',
    likes INTEGER DEFAULT 0,
    answered INTEGER DEFAULT 0,
    pinned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (room_code) REFERENCES rooms(code)
  );

  CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    question TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (room_code) REFERENCES rooms(code)
  );

  CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    votes INTEGER DEFAULT 0,
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
  );
`);

// ── Seed admin account ──────────────────────────────────────
// 강의자 계정: admin / nowsay2024!
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'nowsay2024!';

const existing = db.prepare('SELECT id FROM admin WHERE username = ?').get(ADMIN_USER);
if (!existing) {
  const hash = bcrypt.hashSync(ADMIN_PASS, 10);
  db.prepare('INSERT INTO admin (username, password_hash) VALUES (?, ?)').run(ADMIN_USER, hash);
}

// ── Helper: generate short room code (6 chars) ─────────────
function generateCode() {
  // base36 alphanumeric, 6 chars → ~2 billion combinations
  return crypto.randomBytes(4).toString('base64url').slice(0, 6).toLowerCase();
}

// ── Room CRUD ───────────────────────────────────────────────
const roomStmts = {
  create: db.prepare('INSERT INTO rooms (code, title) VALUES (?, ?)'),
  getByCode: db.prepare('SELECT * FROM rooms WHERE code = ?'),
  list: db.prepare('SELECT * FROM rooms ORDER BY created_at DESC'),
  toggle: db.prepare('UPDATE rooms SET active = ? WHERE code = ?'),
  delete: db.prepare('DELETE FROM rooms WHERE code = ?'),
};

function createRoom(title) {
  let code;
  for (let i = 0; i < 10; i++) {
    code = generateCode();
    try { roomStmts.create.run(code, title); return { code, title }; } catch { /* collision, retry */ }
  }
  throw new Error('Failed to generate unique code');
}

// ── Question CRUD ───────────────────────────────────────────
const qStmts = {
  create: db.prepare('INSERT INTO questions (room_code, text, nickname) VALUES (?, ?, ?)'),
  listByRoom: db.prepare('SELECT * FROM questions WHERE room_code = ? ORDER BY pinned DESC, likes DESC, created_at DESC'),
  like: db.prepare('UPDATE questions SET likes = likes + 1 WHERE id = ?'),
  toggleAnswered: db.prepare('UPDATE questions SET answered = CASE WHEN answered = 0 THEN 1 ELSE 0 END WHERE id = ?'),
  togglePin: db.prepare('UPDATE questions SET pinned = CASE WHEN pinned = 0 THEN 1 ELSE 0 END WHERE id = ?'),
  delete: db.prepare('DELETE FROM questions WHERE id = ?'),
  get: db.prepare('SELECT * FROM questions WHERE id = ?'),
};

// ── Poll CRUD ───────────────────────────────────────────────
const pollStmts = {
  create: db.prepare('INSERT INTO polls (room_code, question) VALUES (?, ?)'),
  getById: db.prepare('SELECT * FROM polls WHERE id = ?'),
  listByRoom: db.prepare('SELECT * FROM polls WHERE room_code = ? ORDER BY created_at DESC'),
  toggle: db.prepare('UPDATE polls SET active = ? WHERE id = ?'),
  delete: db.prepare('DELETE FROM polls WHERE id = ?'),
  addOption: db.prepare('INSERT INTO poll_options (poll_id, text) VALUES (?, ?)'),
  getOptions: db.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY id'),
  vote: db.prepare('UPDATE poll_options SET votes = votes + 1 WHERE id = ?'),
  getOption: db.prepare('SELECT * FROM poll_options WHERE id = ?'),
};

function createPoll(roomCode, question, options) {
  const info = pollStmts.create.run(roomCode, question);
  const pollId = info.lastInsertRowid;
  for (const opt of options) {
    pollStmts.addOption.run(pollId, opt);
  }
  return pollId;
}

module.exports = {
  db, bcrypt,
  ADMIN_USER,
  roomStmts, createRoom,
  qStmts,
  pollStmts, createPoll,
};
