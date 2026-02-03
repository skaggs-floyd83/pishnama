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




    -- ============ AUTH TOKENS (persistent login) ============

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token        TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_auth_tokens_user
      ON auth_tokens(user_id);

    CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires
      ON auth_tokens(expires_at);



      

    -- ============ IMAGES
    CREATE TABLE IF NOT EXISTS images (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Ownership model:
      -- scope = 'user'  => owner_user_id is required
      -- scope = 'global' => owner_user_id is NULL (future: shared catalogs)
      scope         TEXT NOT NULL DEFAULT 'user',
      owner_user_id INTEGER,

      sha256        TEXT NOT NULL,        -- dedup key
      byte_size     INTEGER NOT NULL,
      mime_type     TEXT NOT NULL,        -- e.g. image/jpeg, image/png

      storage_key   TEXT NOT NULL,        -- object key in S3-compatible storage
      etag          TEXT,                 -- provider ETag if available

      created_at    TEXT NOT NULL DEFAULT (datetime('now')),

      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Dedup indexes:
    CREATE UNIQUE INDEX IF NOT EXISTS uq_images_user_hash
      ON images(scope, owner_user_id, sha256);

    CREATE UNIQUE INDEX IF NOT EXISTS uq_images_global_hash
      ON images(scope, sha256)
      WHERE scope = 'global';

    CREATE INDEX IF NOT EXISTS idx_images_owner
      ON images(owner_user_id, created_at DESC);







    -- ============ FABRICS (reusable user fabrics) ============

    CREATE TABLE IF NOT EXISTS fabrics (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id      INTEGER,
      thumb_image_id INTEGER,
      user_id       INTEGER NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE SET NULL,
      FOREIGN KEY (thumb_image_id) REFERENCES images(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_fabrics_user
      ON fabrics(user_id);

    CREATE INDEX IF NOT EXISTS idx_fabrics_image
      ON fabrics(image_id);

    CREATE INDEX IF NOT EXISTS idx_fabrics_thumb_image
      ON fabrics(thumb_image_id);




    -- ============ CREATIONS (history of generations) ============
    
    CREATE TABLE IF NOT EXISTS creations (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id                   INTEGER NOT NULL,
      mode                      TEXT NOT NULL,
      mode_selection            TEXT,
      quality                   TEXT,
      base_image_id             INTEGER,
      base_image_raw_id         INTEGER,
      output_image_id           INTEGER,

      -- NEW: thumbnail links
      base_thumb_image_id       INTEGER,
      base_raw_thumb_image_id   INTEGER,
      output_thumb_image_id     INTEGER,

      meta_json                 TEXT,
      cost_credits              INTEGER NOT NULL,
      created_at                TEXT NOT NULL DEFAULT (datetime('now')),

      FOREIGN KEY (user_id)                 REFERENCES users(id)   ON DELETE CASCADE,
      FOREIGN KEY (base_image_id)           REFERENCES images(id)  ON DELETE SET NULL,
      FOREIGN KEY (base_image_raw_id)       REFERENCES images(id)  ON DELETE SET NULL,
      FOREIGN KEY (output_image_id)         REFERENCES images(id)  ON DELETE SET NULL,
      FOREIGN KEY (base_thumb_image_id)     REFERENCES images(id)  ON DELETE SET NULL,
      FOREIGN KEY (base_raw_thumb_image_id) REFERENCES images(id)  ON DELETE SET NULL,
      FOREIGN KEY (output_thumb_image_id)   REFERENCES images(id)  ON DELETE SET NULL
    );



    CREATE INDEX IF NOT EXISTS idx_creations_user_created
      ON creations(user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_creations_output_image
      ON creations(output_image_id);

    CREATE INDEX IF NOT EXISTS idx_creations_base_image_raw
      ON creations(base_image_raw_id);

    
    CREATE INDEX IF NOT EXISTS idx_creations_base_thumb
      ON creations(base_thumb_image_id);

    CREATE INDEX IF NOT EXISTS idx_creations_output_thumb
      ON creations(output_thumb_image_id);


      

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

  ensureColumnExists("creations", "base_thumb_image_id", "INTEGER");
  ensureColumnExists("creations", "base_raw_thumb_image_id", "INTEGER");
  ensureColumnExists("creations", "output_thumb_image_id", "INTEGER");
  ensureColumnExists("fabrics", "thumb_image_id", "INTEGER");
}

function ensureColumnExists(table, column, type) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some(col => col.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Export the db handle for queries later
export { db };
