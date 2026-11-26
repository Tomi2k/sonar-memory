// Idempotente, 100 % abwärtskompatible Schema-Migrationen auf der kanonischen memory.db.
// Bestehende Tabellen (memory_entries, episodes, reasoning_patterns, causal_edges usw.) bleiben voll erhalten.

export const SCHEMA_VERSION = 2;

function hasColumn(db, table, col) {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
  return rows.some((r) => r.name === col);
}

export function ensureCanonicalSchema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('secure_delete = ON');

  // Basis-Tabelle falls ganz neue DB (z. B. in Unit-/Contract-Tests)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      namespace TEXT DEFAULT 'default',
      content TEXT NOT NULL,
      type TEXT DEFAULT 'semantic',
      embedding TEXT,
      embedding_model TEXT DEFAULT 'local',
      embedding_dimensions INTEGER,
      tags TEXT,
      metadata TEXT,
      owner_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      expires_at INTEGER,
      last_accessed_at INTEGER,
      access_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      provenance_type TEXT DEFAULT 'unknown',
      UNIQUE(namespace, key)
    );
  `);

  // P4 (Punkt 2.3): Additive Spalten an memory_entries (mit sicheren Defaults, bricht Alt-Reader nie!)
  const extraCols = [
    ['kind', "TEXT DEFAULT 'pattern'"],
    ['valid_from', 'INTEGER'],
    ['valid_to', 'INTEGER'],
    ['review_after', 'INTEGER'],
    ['scope', "TEXT DEFAULT 'global'"],
    ['superseded_by', 'TEXT']
  ];
  for (const [col, def] of extraCols) {
    if (!hasColumn(db, 'memory_entries', col)) {
      db.exec(`ALTER TABLE memory_entries ADD COLUMN ${col} ${def};`);
    }
  }

  // P4 (Punkt 2.3): Relationstabelle für supersedes, contradicts, refines, duplicates
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_ref TEXT NOT NULL,
      to_ref TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('supersedes', 'contradicts', 'refines', 'duplicates')),
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'dismissed')),
      reason TEXT DEFAULT '',
      created_by TEXT DEFAULT 'agent',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolved_by TEXT,
      winner_ref TEXT,
      UNIQUE(from_ref, to_ref, type)
    );
    CREATE INDEX IF NOT EXISTS idx_rel_from ON memory_relations(from_ref, type, state);
    CREATE INDEX IF NOT EXISTS idx_rel_to ON memory_relations(to_ref, type, state);
    CREATE INDEX IF NOT EXISTS idx_rel_open ON memory_relations(type, state);
  `);

  // P2/P3: Monotones Änderungsjournal für inkrementellen Index-Catchup ohne verlorene Writes
  db.exec(`
    CREATE TABLE IF NOT EXISTS sonar_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('upsert', 'delete', 'purge', 'relation', 'status')),
      detail TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sonar_changes_ts ON sonar_changes(ts);
  `);

  // Metadaten-Tabelle für Schema-Stand
  db.exec(`
    CREATE TABLE IF NOT EXISTS sonar_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO sonar_meta(key, value, updated_at) VALUES ('schema_version', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(String(SCHEMA_VERSION), Date.now());
}
