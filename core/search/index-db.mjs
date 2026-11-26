// Abgeleitete SQLite-Suchdatenbank (`index-<gen>.db`):
// - Volltexte liegen ausschließlich in SQLite (nie komplett im V8-RAM!)
// - Dreischichtiger Textindex: fts_main (exact 2x + stem 1x), fts_ident (trigram detail=none), chunk_keys (B-Tree < 5 ms)
// - Vektor-Slots verknüpfen Chunks mit dem kompakten Off-Heap INT8-Buffer (`vectors.i8`) + FP32-Rescoring (`vectors.f32`)
import Database from 'better-sqlite3';

export const INDEX_SCHEMA_VERSION = 1;

export function createIndexDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('secure_delete = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536'); // 64 MB Build-Cache

  db.exec(`
    CREATE TABLE index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      namespace TEXT NOT NULL,
      project TEXT NOT NULL,
      uri TEXT NOT NULL,
      relative_path TEXT DEFAULT '',
      hash TEXT NOT NULL,
      updated INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'current',
      kind TEXT NOT NULL DEFAULT 'doc',
      trust TEXT NOT NULL DEFAULT 'workspace-doc',
      tier TEXT NOT NULL DEFAULT 'curated',
      provenance TEXT NOT NULL DEFAULT 'unknown',
      superseded_by TEXT,
      alt_paths_json TEXT DEFAULT '[]',
      text_len INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX idx_sources_ns_key ON sources(namespace, key);
    CREATE INDEX idx_sources_project ON sources(project);
    CREATE INDEX idx_sources_tier ON sources(tier);
    CREATE INDEX idx_sources_hash ON sources(hash);

    CREATE TABLE chunks (
      chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      start_off INTEGER NOT NULL,
      end_off INTEGER NOT NULL,
      title TEXT DEFAULT '',
      header TEXT DEFAULT '',
      chunk_hash TEXT NOT NULL,
      vec_slot INTEGER,
      raw_text TEXT NOT NULL
    );
    CREATE INDEX idx_chunks_source ON chunks(source_id);
    CREATE INDEX idx_chunks_vec_slot ON chunks(vec_slot) WHERE vec_slot IS NOT NULL;
    CREATE INDEX idx_chunks_hash ON chunks(chunk_hash);

    -- Exakter Schlüssel-/Ticket-ID-Index (B-Tree, < 5 ms Fast-Path)
    CREATE TABLE chunk_keys (
      key_norm TEXT NOT NULL,
      chunk_id INTEGER NOT NULL,
      source_id TEXT NOT NULL
    );
    CREATE INDEX idx_chunk_keys_norm ON chunk_keys(key_norm);

    -- Wortindex: Spalte 0 = exact (Gewicht 2.0), Spalte 1 = stem (Gewicht 1.0)
    -- Contentless spart massig Platz; Anzeigetext kommt aus chunks.raw_text
    CREATE VIRTUAL TABLE fts_main USING fts5(
      exact,
      stem,
      content='',
      contentless_delete=1,
      tokenize='unicode61 remove_diacritics 0'
    );

    -- Schlanker Trigramm-Index NUR für Pfade, Überschriften, Schlüssel & Bezeichner
    CREATE VIRTUAL TABLE fts_ident USING fts5(
      ident,
      tokenize='trigram',
      detail=none
    );
  `);

  return db;
}

export function openIndexDatabaseReadOnly(dbPath, options = {}) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  // Page-Cache & mmap (max 256 MB Cache + 512 MB mmap im OS-Page-Cache, nicht V8-Heap!)
  db.pragma(`cache_size = -${(options.cacheMb ?? 128) * 1024}`);
  db.pragma(`mmap_size = ${(options.mmapMb ?? 512) * 1024 * 1024}`);
  db.pragma('query_only = ON');
  return db;
}

export function readIndexMeta(db) {
  const meta = {};
  for (const r of db.prepare('SELECT key, value FROM index_meta').all()) {
    try { meta[r.key] = JSON.parse(r.value); } catch { meta[r.key] = r.value; }
  }
  return meta;
}
