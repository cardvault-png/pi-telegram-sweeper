const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function openDatabase() {
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'wallet-monitor.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_native TEXT,
      last_seen_at INTEGER,
      UNIQUE(chat_id, public_key)
    );
  `);
  return db;
}
module.exports = { openDatabase };
