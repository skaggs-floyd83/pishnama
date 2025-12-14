// db.js
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the SQLite file
const dbPath = path.join(__dirname, "data", "pishneshan.db");

// Open (or create) the database
const db = new Database(dbPath);

// Enforce foreign keys
db.pragma("foreign_keys = ON");

// Run migrations once at startup
export function runMigrations() {
  db.exec(`
    BEGIN;

    -- ============ USERS ============

    CREATE TABLE IF NOT EXISTS users (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier        TEXT NOT NULL UNIQUE,  -- email or normalized phone (+98...)
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      credits           INTEGER NOT NULL DEFAULT 0,
      credits_expires_at TEXT                  -- ISO datetime string, NULL = no expiry
    );

    CREATE INDEX IF NOT EXISTS idx_users_identifier
      ON users(identifier);

    -- ============ FABRICS (reusable user fabrics) ============

    CREATE TABLE IF NOT EXISTS fabrics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      file_path   TEXT NOT NULL,              -- relative path or full CDN URL
      file_hash   TEXT,                       -- optional: for deduplication
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_fabrics_user
      ON fabrics(user_id);

    -- ============ CREATIONS (history of generations) ============

    CREATE TABLE IF NOT EXISTS creations (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id            INTEGER NOT NULL,
      mode               TEXT NOT NULL,       -- 'sofa', 'pillows', 'carpet', 'drapery', ...
      mode_selection     TEXT,                -- 'all', 'partial', 'single', 'random', etc.
      quality            TEXT,                -- 'high' | 'standard'
      base_image_path    TEXT,                -- stored original image file
      output_image_path  TEXT,                -- generated result file
      meta_json          TEXT,                -- raw meta sent from frontend (for debugging)
      cost_credits       INTEGER NOT NULL,    -- credits spent for this creation
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_creations_user_created
      ON creations(user_id, created_at DESC);

    -- ============ CREATION_FABRICS (bridge: which fabrics used in a creation) ============

    CREATE TABLE IF NOT EXISTS creation_fabrics (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      creation_id  INTEGER NOT NULL,
      fabric_id    INTEGER NOT NULL,
      ord          INTEGER NOT NULL,          -- 1,2,3: position of fabric in this creation
      part         TEXT,                      -- 'back','seat','arms','all','pillows','random', etc.
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (creation_id) REFERENCES creations(id) ON DELETE CASCADE,
      FOREIGN KEY (fabric_id)   REFERENCES fabrics(id)   ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_creation_fabrics_creation
      ON creation_fabrics(creation_id);

    CREATE INDEX IF NOT EXISTS idx_creation_fabrics_fabric
      ON creation_fabrics(fabric_id);

    COMMIT;
  `);
}

// Export the db handle for queries later
export { db };
