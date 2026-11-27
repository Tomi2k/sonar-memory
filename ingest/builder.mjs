// P1 + P2 + P5: Abgeleiteter Index-Builder für Sonar.
// - 2-Stufen Korpus-Hygiene (curated = FTS5 + INT8-Vektor, archive = nur FTS5, Worktrees/.expires raus)
// - Inhalts-Deduplizierung (erhält alle Pfade in alt_paths_json)
// - Kontext-Header ("Pfad › H1 › H2") + versionierter Chunker + Gitleaks mit Regelversion
// - Fortsetzbarer Embedding-Cache + MemAvailable >= 4 GiB Pause-Wächter
// - Atomare Generation: wal_checkpoint(TRUNCATE) + PRAGMA quick_check + CURRENT-Tausch + 2 Generationen behalten
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createIndexDatabase, INDEX_SCHEMA_VERSION } from '../core/search/index-db.mjs';
import { CanonicalStore } from '../core/store/canonical.mjs';
import { expandHome } from '../core/paths.mjs';
import { quantizeInt8 } from '../core/search/vector-scan.mjs';
import { chunkText, CHUNKER_VERSION } from '../core/chunker.mjs';
import { screenSources } from '../core/secret-screen.mjs';
import {
  NORM_VERSION,
  normalizeForExactFts,
  normalizeForStemFts,
  extractExactKeys,
  normalizeText
} from '../core/normalize.mjs';
import {
  POLICY_VERSION,
  createPolicy,
  isTrustedSource,
  shouldSkipDirectory,
  detectProject,
  classifyKind,
  classifyTrust,
  classifyMarkdownSource
} from './policy.mjs';

const __builderDir = path.dirname(fileURLToPath(import.meta.url));
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

function readMemAvailableGiB() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = txt.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (m) return Number(m[1]) / (1024 * 1024);
  } catch { /* macOS / non-Linux */ }
  return 999;
}

const ALLOWED_FM_STATUS = new Set(['current', 'active', 'draft', 'deprecated', 'historical', 'archived']);

function parseFrontmatterStatus(text) {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end < 0 || end > 2000) return {};
  const fm = text.slice(4, end);
  const statusM = fm.match(/^status:\s*([^\n#]+)/m);
  const supM = fm.match(/^superseded_by:\s*([^\n#]+)/m);
  const rawStatus = statusM ? statusM[1].trim().replace(/^['"]|['"]$/g, '').toLowerCase() : null;
  return {
    fmStatus: rawStatus && ALLOWED_FM_STATUS.has(rawStatus) ? rawStatus : null,
    fmSupersededBy: supM ? supM[1].trim().replace(/^['"]|['"]$/g, '') : null
  };
}

function acquireIndexLock(indexRoot) {
  const lockPath = path.join(indexRoot, '.build.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
      fs.closeSync(fd);
      return lockPath;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      // Check whether the lock holder PID is still alive; remove stale lock if dead
      let alive = false;
      try {
        const pid = Number(fs.readFileSync(lockPath, 'utf8').split('\n')[0]);
        if (pid > 0) {
          try {
            process.kill(pid, 0);
            alive = true;
          } catch (killErr) {
            // EPERM means a live process owned by another UID holds the lock; only ESRCH means dead.
            alive = killErr?.code !== 'ESRCH';
          }
        }
      } catch { alive = false; }
      if (alive || attempt > 0) {
        throw new Error(`Another Sonar reindex process holds ${lockPath}`);
      }
      try { fs.unlinkSync(lockPath); } catch { /* race */ }
    }
  }
  throw new Error(`Unable to acquire lock ${lockPath}`);
}

/**
 * Sammelt alle Quellen aus kanonischer SQLite-DB + gespiegelten Markdown-Wurzeln
 * und wendet die 2-Stufen Korpus-Hygiene + Content-Hash-Deduplizierung an.
 */
export function collectAndClassifySources({ database, sourceRoots = [], policy = null, trustedRoots = [], dryRunStats = null }) {
  const pol = policy && policy.skipDirs ? policy : createPolicy(policy, { trustedRoots });
  const dbFile = path.resolve(expandHome(database));
  if (!fs.existsSync(dbFile)) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
    const prevUmask = process.umask(0o077);
    try {
      const initStore = new CanonicalStore(dbFile);
      initStore.close();
    } finally {
      process.umask(prevUmask);
    }
  }
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  const now = Date.now();
  const rawSources = [];
  const skipStats = {};
  const bumpSkip = (reason) => { skipStats[reason] = (skipStats[reason] || 0) + 1; };

  let canonicalSeq = 0;
  let latestPurgeSeq = 0;
  let dbEntryCount = 0;
  const namespaces = {};

  try {
    const hasChanges = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sonar_changes'").get();
    if (hasChanges) {
      canonicalSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM sonar_changes').get().seq;
      latestPurgeSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM sonar_changes WHERE op = 'purge'").get().seq;
    }

    const memories = db.prepare('SELECT * FROM memory_entries').all();
    const tombstones = new Set(
      memories.filter((r) => r.status === 'deleted').flatMap((r) => [r.key, `${r.namespace}/${r.key}`])
    );

    for (const r of memories) {
      if (r.status === 'deleted') { bumpSkip('db-deleted'); continue; }
      if (r.expires_at && r.expires_at <= now) { bumpSkip('db-expired'); continue; }
      const text = r.content || '';
      if (!text.trim()) { bumpSkip('db-empty'); continue; }
      dbEntryCount++;
      namespaces[r.namespace] = (namespaces[r.namespace] || 0) + 1;
      const isSuperseded = r.status === 'archived' || Boolean(r.superseded_by);
      rawSources.push({
        id: `memory_entries:${r.id}`,
        key: r.key,
        namespace: r.namespace,
        project: '',
        uri: `sonar://memory_entries/${r.id}`,
        relativePath: `${r.namespace}/${r.key}`,
        text,
        hash: sha(text),
        updated: r.updated_at || r.created_at || now,
        status: isSuperseded ? 'archived' : 'active',
        kind: r.kind || (r.namespace === 'patterns' ? 'pattern' : 'doc'),
        trust: 'internal-memory',
        tier: 'curated',
        provenance: r.provenance_type || 'unknown',
        superseded_by: r.superseded_by || null
      });
    }

    // Historische Legacy-Tabellen (episodes, reasoning_patterns, causal_edges) bleiben als Tier 2 (archive, nur FTS5) voll durchsuchbar!
    const legacyLayouts = {
      episodes: ['task', 'input', 'output', 'critique'],
      reasoning_patterns: ['task_type', 'approach'],
      causal_edges: ['mechanism', 'metadata', 'from_memory_id', 'to_memory_id']
    };
    const existingTables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name)
    );
    for (const [table, fields] of Object.entries(legacyLayouts)) {
      if (!existingTables.has(table)) continue;
      for (const r of db.prepare(`SELECT * FROM "${table}"`).all()) {
        if (r.status === 'deleted' || (r.expires_at && r.expires_at <= now)) continue;
        const text = fields.filter((f) => r[f] != null).map((f) => `${f}: ${r[f]}`).join('\n');
        if (!text.trim()) continue;
        rawSources.push({
          id: `${table}:${r.id}`,
          key: String(r.id),
          namespace: table,
          project: '',
          uri: `sonar://${table}/${r.id}`,
          relativePath: `${table}/${r.id}`,
          text,
          hash: sha(text),
          updated: r.updated_at || r.created_at || r.ts || 0,
          status: 'historical',
          kind: table === 'episodes' ? 'event' : 'pattern',
          trust: 'archive-doc',
          tier: 'archive',
          provenance: 'legacy-table',
          superseded_by: null
        });
      }
    }

    // Mirrored or local Markdown source folders
    for (const rawRoot of sourceRoots) {
      const root = path.resolve(expandHome(rawRoot));
      if (!fs.existsSync(root)) continue;
      const rootName = path.basename(root);
      const rootPrefix = `markdown:${rootName}-${sha(root).slice(0, 8)}:`;
      const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            const skipReason = shouldSkipDirectory(full, e.name, pol);
            if (skipReason) { bumpSkip(skipReason); continue; }
            walk(full);
            continue;
          }
          if (!e.isFile() || !e.name.endsWith('.md')) continue;
          const rel = path.relative(root, full);
          const key = e.name.slice(0, -3);
          if (tombstones.has(`auto-memory/${key}`) && rel.includes('/memory/')) {
            bumpSkip('tombstone-auto-memory');
            continue;
          }
          let st;
          let cls;
          let text;
          let fd = null;
          try {
            const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
            fd = fs.openSync(full, openFlags);
            st = fs.fstatSync(fd);
            if (!st.isFile()) continue;
            cls = classifyMarkdownSource(rel, e.name, st.size, pol);
            if (cls.tier === 'exclude') {
              bumpSkip(cls.reason);
              continue;
            }
            text = fs.readFileSync(fd, 'utf8');
          } catch {
            continue;
          } finally {
            if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
          }
          const { fmStatus, fmSupersededBy } = parseFrontmatterStatus(text);
          const project = detectProject(rel, pol);
          const baseSrc = {
            id: `${rootPrefix}${rel.split(path.sep).join('/')}`,
            key,
            namespace: 'markdown',
            project,
            uri: `file://${full}`,
            fullPath: full,
            relativePath: rel.split(path.sep).join('/'),
            text,
            hash: sha(text),
            updated: Math.round(st.mtimeMs),
            status: cls.tier === 'archive' ? 'historical' : 'current',
            tier: cls.tier,
            provenance: `markdown:${rootName}`,
            superseded_by: null
          };
          const trusted = isTrustedSource(baseSrc, pol);
          if (fmStatus && trusted) baseSrc.status = fmStatus;
          baseSrc.kind = classifyKind(baseSrc, pol);
          baseSrc.trust = classifyTrust(baseSrc, pol);
          // Only honor Markdown frontmatter `superseded_by` inside explicitly trusted roots
          // AND only when pointing to another document inside the exact same root.
          if (fmSupersededBy && trusted && fmSupersededBy.startsWith(rootPrefix)) {
            baseSrc.superseded_by = fmSupersededBy;
          }
          rawSources.push(baseSrc);
        }
      };
      walk(root);
    }
  } finally {
    db.close();
  }

  // Dokument-Deduplizierung nach Content-Hash:
  // Bevorzugt höhere Vertrauensstufe (`own-rule` > `curated` > `archive`), speichert ALLE Zweitpfade in altPaths!
  const dedupeRank = (item) => (item.trust === 'own-rule' ? 3 : (item.tier === 'curated' ? 2 : 1));
  const deduped = new Map();
  let duplicateDocsMerged = 0;
  for (const s of rawSources) {
    // DB-Einträge nie mit Markdown zusammenführen (verschiedene Autoritäten)
    const dedupeKey = s.id.startsWith('memory_entries:') ? s.id : `md:${s.hash}`;
    const prev = deduped.get(dedupeKey);
    if (!prev) {
      s.altPaths = [];
      deduped.set(dedupeKey, s);
    } else {
      duplicateDocsMerged++;
      if (dedupeRank(s) > dedupeRank(prev)) {
        s.altPaths = [...prev.altPaths, { id: prev.id, project: prev.project, uri: prev.uri }];
        deduped.set(dedupeKey, s);
      } else {
        prev.altPaths.push({ id: s.id, project: s.project, uri: s.uri });
      }
    }
  }

  const sources = [...deduped.values()];
  if (dryRunStats) {
    dryRunStats.rawCount = rawSources.length;
    dryRunStats.dedupedCount = sources.length;
    dryRunStats.duplicateDocsMerged = duplicateDocsMerged;
    dryRunStats.skipStats = skipStats;
  }

  return { sources, canonicalSeq, latestPurgeSeq, dbEntryCount, namespaces, skipStats, duplicateDocsMerged };
}

/**
 * Baut eine vollständige, atomar umschaltbare Index-Generation (`index.db` + `vectors.i8` + `scales.f32` + `vectors.f32`).
 */
export async function buildIndexGeneration({
  indexRoot,
  database,
  sourceRoots = [],
  policy = null,
  trustedRoots = [],
  embedder,
  screenOptions = {},
  batchSize = 16,
  workers = 1,
  workerThreads = 2,
  maxPassages = null,
  minMemAvailableGiB = 4.0,
  activate = true,
  force = false,
  onProgress = null
}) {
  const pol = policy && policy.skipDirs ? policy : createPolicy(policy, { trustedRoots });
  const resolvedIndexRoot = path.resolve(expandHome(indexRoot));
  const resolvedDatabase = path.resolve(expandHome(database));
  indexRoot = resolvedIndexRoot;
  database = resolvedDatabase;
  const started = Date.now();
  fs.mkdirSync(indexRoot, { recursive: true, mode: 0o700 });
  const lockPath = acquireIndexLock(indexRoot);
  const releaseLock = () => { try { fs.unlinkSync(lockPath); } catch { /* ignore */ } };
  const cacheDbPath = path.join(indexRoot, 'embed-cache.db');
  let cacheDb = null;
  try {
    cacheDb = new Database(cacheDbPath);
    cacheDb.pragma('journal_mode = WAL');
    cacheDb.pragma('synchronous = NORMAL');
    cacheDb.pragma('busy_timeout = 5000');
    cacheDb.pragma('secure_delete = ON');
  cacheDb.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      cache_key TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      vec BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const getCacheStmt = cacheDb.prepare('SELECT vec FROM embeddings WHERE cache_key = ?');
  const putCacheStmt = cacheDb.prepare(
    'INSERT OR REPLACE INTO embeddings(cache_key, model_id, vec, created_at) VALUES (?, ?, ?, ?)'
  );
  const putCacheBatch = cacheDb.transaction((items) => {
    const now = Date.now();
    for (const it of items) putCacheStmt.run(it.cacheKey, it.modelId, it.buf, now);
  });

  await embedder.init();
  const embInfo = embedder.info();

  const collected = collectAndClassifySources({ database, sourceRoots, policy: pol });
  const screened = screenSources(collected.sources, indexRoot, screenOptions);
  const sources = screened.safe;

  // Fingerprint umfasst Quellen + Modell + Normalizer + Chunker + Policy + Trust/Kind/Project + Scanner-Version
  const fpInput = JSON.stringify([
    INDEX_SCHEMA_VERSION,
    POLICY_VERSION,
    pol.version,
    CHUNKER_VERSION,
    NORM_VERSION,
    embInfo.modelId,
    embInfo.modelHash,
    screened.scannerSignature,
    collected.latestPurgeSeq || 0,
    sources.map((s) => [s.id, s.hash, s.tier, s.status, s.trust, s.kind, s.project, s.superseded_by])
  ]);
  const fingerprint = sha(fpInput).slice(0, 24);
  const modelSlug = embInfo.modelId.split('/').pop().replace(/[^a-zA-Z0-9_-]/g, '-');
  const generation = `generation-${modelSlug}-${fingerprint}`;
  const finalDir = path.join(indexRoot, generation);

  // Fast-Skip: wenn aktive Generation exakt denselben Fingerprint hat (keine Quelle geändert), sofort beenden!
  const curPath = path.join(indexRoot, 'CURRENT');
  if (!force && !maxPassages && activate && fs.existsSync(curPath) && fs.readFileSync(curPath, 'utf8').trim() === generation && fs.existsSync(path.join(finalDir, 'index.db'))) {
    cacheDb.close();
    return {
      skipped: true,
      reason: 'unchanged-fingerprint',
      generation,
      modelId: embInfo.modelId,
      sourceCount: sources.length,
      buildMs: Date.now() - started
    };
  }

  const partialDir = path.join(indexRoot, `.partial-${generation}-${process.pid}`);
  fs.rmSync(partialDir, { recursive: true, force: true });
  fs.mkdirSync(partialDir, { recursive: true, mode: 0o700 });

  let db = null;
  let fdI8 = null;
  let fdScales = null;
  let fdF32 = null;

  try {
    db = createIndexDatabase(path.join(partialDir, 'index.db'));
    fdI8 = fs.openSync(path.join(partialDir, 'vectors.i8'), 'w', 0o600);
    fdScales = fs.openSync(path.join(partialDir, 'scales.f32'), 'w', 0o600);
    fdF32 = fs.openSync(path.join(partialDir, 'vectors.f32'), 'w', 0o600);

    const insertSource = db.prepare(`
      INSERT INTO sources(
        id, key, namespace, project, uri, relative_path, hash, updated,
        status, kind, trust, tier, provenance, superseded_by, alt_paths_json, text_len, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = db.prepare(`
      INSERT INTO chunks(source_id, start_off, end_off, title, header, chunk_hash, vec_slot, raw_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFtsMain = db.prepare('INSERT INTO fts_main(rowid, exact, stem) VALUES (?, ?, ?)');
    const insertFtsIdent = db.prepare('INSERT INTO fts_ident(rowid, ident) VALUES (?, ?)');
    const insertKey = db.prepare('INSERT INTO chunk_keys(key_norm, chunk_id, source_id) VALUES (?, ?, ?)');

    // 1. Quellen & Chunks erzeugen in 1.500er-Transaktions-Blöcken (hält SQLite FTS5-RAM unter 250 MB!)
    const totalSourceCount = sources.length;
    const uniqueCacheKeys = new Map(); // cacheKey -> { firstChunkId, len, chunkIds: [] }
    let curatedCount = 0;
    let archiveCount = 0;
    let totalChunks = 0;

    const writeSourceBatch = db.transaction((batch) => {
      for (const s of batch) {
        if (s.tier === 'curated') curatedCount++;
        else archiveCount++;

        insertSource.run(
          s.id, s.key, s.namespace, s.project, s.uri, s.relativePath || '',
          s.hash, s.updated, s.status, s.kind, s.trust, s.tier,
          s.provenance, s.superseded_by || null, JSON.stringify(s.altPaths || []),
          s.text.length, s.text
        );

        const pieces = chunkText(s.text, s);
        const docKeys = extractExactKeys(`${s.key} ${s.relativePath || ''}`, [s.key, s.id, s.id.replace(/^memory_entries:/, '')]);

        for (let idx = 0; idx < pieces.length; idx++) {
          const ch = pieces[idx];
          const chunkHash = sha(ch.embedText);
          const info = insertChunk.run(
            s.id, ch.start, ch.end, ch.title || '', ch.header || '', chunkHash, null, ch.rawText
          );
          const chunkId = Number(info.lastInsertRowid);
          totalChunks++;

          // FTS5 Wortindex (exact + stem, inkl. Kontext-Header!)
          const ftsText = `${ch.header}${ch.rawText}`;
          insertFtsMain.run(chunkId, normalizeForExactFts(ftsText), normalizeForStemFts(ftsText));

          // Schlanker Trigramm-Index NUR für Pfad, Schlüssel, Titel & Bezeichner
          const identText = normalizeText(`${s.project} ${s.key} ${s.relativePath || ''} ${ch.title || ''}`);
          insertFtsIdent.run(chunkId, identText);

          // B-Tree Schlüssel (Dokument-Schlüssel an Chunk 0, Ticket-IDs an jedem Chunk)
          const chunkKeys = idx === 0
            ? extractExactKeys(ch.rawText, docKeys)
            : extractExactKeys(ch.rawText);
          for (const k of chunkKeys) {
            insertKey.run(k, chunkId, s.id);
          }

          // Nur Tier 1 (`curated`) erhält Vektoren — speichere im RAM nur Metadaten, Text liegt in SQLite!
          if (s.tier === 'curated') {
            const cacheKey = sha(`${embInfo.modelHash}\0${embInfo.passagePrefix}\0${ch.embedText}`);
            let group = uniqueCacheKeys.get(cacheKey);
            if (!group) {
              group = { firstChunkId: chunkId, len: ch.embedText.length, chunkIds: [] };
              uniqueCacheKeys.set(cacheKey, group);
            }
            group.chunkIds.push(chunkId);
          }
        }
        // Rohtext sofort für GC freigeben!
        s.text = '';
      }
    });
    for (let i = 0; i < sources.length; i += 1500) {
      writeSourceBatch(sources.slice(i, i + 1500));
    }
    collected.sources.length = 0;
    screened.safe.length = 0;
    global.gc?.();

    // 2. Längensortiertes Batching (3–4x schneller auf CPU durch minimales Padding!) + SQLite embed-cache.db
    let workList = [...uniqueCacheKeys.entries()].sort((a, b) => a[1].len - b[1].len);
    if (maxPassages && workList.length > maxPassages) {
      workList = workList.slice(0, maxPassages);
    }

    const readChunkTextStmt = db.prepare('SELECT header, raw_text FROM chunks WHERE chunk_id = ?');
    const updateVecSlot = db.prepare('UPDATE chunks SET vec_slot = ? WHERE chunk_id = ?');
    let cacheHits = 0;
    let newlyEmbedded = 0;
    const dim = embInfo.dimensions;

    const assignSlots = db.transaction((assignments) => {
      for (const [slot, chunkIds] of assignments) {
        for (const cid of chunkIds) updateVecSlot.run(slot, cid);
      }
    });

    // Optional parallel worker pool for faster initial index builds (e.g. --workers 3 --threads 2 on an 8-core host)
    const workerCount = Math.max(1, Number(workers) || 1);
    const missingTotal = [];
    for (const [cacheKey, group] of workList) {
      const hit = getCacheStmt.get(cacheKey);
      if (!hit || !hit.vec || hit.vec.byteLength !== dim * 4) {
        missingTotal.push({ cacheKey, firstChunkId: group.firstChunkId });
      }
    }
    cacheHits = workList.length - missingTotal.length;

    if (missingTotal.length > 0 && workerCount > 1 && embedder.modelRoot) {
      const pool = [];
      for (let w = 0; w < workerCount; w++) {
        const wk = new Worker(path.join(__builderDir, 'embed-worker.mjs'), {
          workerData: {
            modelRoot: embedder.modelRoot,
            modelId: embInfo.modelId,
            intraThreads: workerThreads
          }
        });
        await new Promise((resolve, reject) => {
          wk.once('message', (m) => (m?.type === 'ready' ? resolve() : reject(new Error('Worker init failed'))));
          wk.once('error', reject);
        });
        pool.push(wk);
      }

      try {
        let nextIdx = 0;
        let doneMissing = 0;
        let jobSeq = 1;
        const runWorker = async (wk) => {
          while (nextIdx < missingTotal.length) {
            const availGiB = readMemAvailableGiB();
            if (availGiB < minMemAvailableGiB) {
              await new Promise((r) => setTimeout(r, 1500));
            }
            const start = nextIdx;
            nextIdx += batchSize;
            const batch = missingTotal.slice(start, start + batchSize);
            if (!batch.length) break;
            const texts = batch.map((b) => {
              const r = readChunkTextStmt.get(b.firstChunkId);
              return `${r.header || ''}${r.raw_text || ''}`;
            });
            const jobId = jobSeq++;
            const buffers = await new Promise((resolve, reject) => {
              const onMsg = (m) => {
                if (m.jobId !== jobId) return;
                wk.off('message', onMsg);
                if (m.type === 'result') resolve(m.buffers);
                else reject(new Error(m.error || 'Worker embed error'));
              };
              wk.on('message', onMsg);
              wk.postMessage({ type: 'embed', jobId, texts });
            });
            const toStore = batch.map((b, j) => ({ cacheKey: b.cacheKey, modelId: embInfo.modelId, buf: Buffer.from(buffers[j]) }));
            putCacheBatch(toStore);
            newlyEmbedded += batch.length;
            doneMissing += batch.length;
            if (onProgress && (doneMissing % (batchSize * 20) < batchSize || doneMissing >= missingTotal.length)) {
              onProgress({
                done: cacheHits + doneMissing,
                total: workList.length,
                cacheHits,
                newlyEmbedded,
                elapsedMs: Date.now() - started
              });
            }
          }
        };
        await Promise.all(pool.map((wk) => runWorker(wk)));
      } finally {
        for (const wk of pool) {
          try { wk.postMessage({ type: 'stop' }); } catch { /* ignore */ }
          try { await wk.terminate(); } catch { /* ignore */ }
        }
      }
    } else if (missingTotal.length > 0) {
      for (let offset = 0; offset < missingTotal.length; offset += batchSize) {
        const availGiB = readMemAvailableGiB();
        if (availGiB < minMemAvailableGiB) {
          await new Promise((r) => setTimeout(r, 1500));
        }
        const batch = missingTotal.slice(offset, offset + batchSize);
        const texts = batch.map((b) => {
          const r = readChunkTextStmt.get(b.firstChunkId);
          return `${r.header || ''}${r.raw_text || ''}`;
        });
        const vecs = await embedder.embedPassages(texts);
        const toStore = [];
        for (let j = 0; j < batch.length; j++) {
          const buf = Buffer.from(vecs[j].buffer, vecs[j].byteOffset, vecs[j].byteLength);
          toStore.push({ cacheKey: batch[j].cacheKey, modelId: embInfo.modelId, buf });
          newlyEmbedded++;
        }
        putCacheBatch(toStore);
        if (onProgress && ((offset / batchSize) % 25 === 0 || offset + batchSize >= missingTotal.length)) {
          onProgress({
            done: cacheHits + Math.min(missingTotal.length, offset + batchSize),
            total: workList.length,
            cacheHits,
            newlyEmbedded,
            elapsedMs: Date.now() - started
          });
        }
      }
    }

    // 3. Streaming-Ausgabe aller Vektoren aus embed-cache.db nach vectors.i8 + scales.f32 + vectors.f32
    let slotCounter = 0;
    for (let offset = 0; offset < workList.length; offset += 256) {
      const slice = workList.slice(offset, offset + 256);
      const batchAssignments = [];
      const batchI8 = [];
      const batchScales = [];
      const batchF32 = [];
      for (const [cacheKey, group] of slice) {
        const hit = getCacheStmt.get(cacheKey);
        if (!hit || !hit.vec || hit.vec.byteLength !== dim * 4) {
          throw new Error(`Fehlender Cache-Vektor für ${cacheKey}`);
        }
        const raw = hit.vec;
        const f32 = new Float32Array(raw.buffer, raw.byteOffset, dim);
        const { q, scale } = quantizeInt8(f32);
        batchI8.push(Buffer.from(q.buffer, q.byteOffset, q.byteLength));
        const sBuf = Buffer.allocUnsafe(4);
        sBuf.writeFloatLE(scale, 0);
        batchScales.push(sBuf);
        batchF32.push(raw);
        batchAssignments.push([slotCounter, group.chunkIds]);
        slotCounter++;
      }
      fs.writeSync(fdI8, Buffer.concat(batchI8));
      fs.writeSync(fdScales, Buffer.concat(batchScales));
      fs.writeSync(fdF32, Buffer.concat(batchF32));
      assignSlots(batchAssignments);
    }

    // Prune orphaned/purged vectors from embed-cache.db on full builds (keeps active corpus cached!)
    let prunedCacheEntries = 0;
    if (!maxPassages) {
      cacheDb.exec('CREATE TEMP TABLE IF NOT EXISTS _active_keys(k TEXT PRIMARY KEY); DELETE FROM _active_keys;');
      const insActive = cacheDb.prepare('INSERT OR IGNORE INTO _active_keys(k) VALUES (?)');
      const loadActive = cacheDb.transaction((keys) => {
        for (const k of keys) insActive.run(k);
      });
      loadActive(uniqueCacheKeys.keys());
      const delInfo = cacheDb.prepare(
        'DELETE FROM embeddings WHERE model_id = ? AND cache_key NOT IN (SELECT k FROM _active_keys)'
      ).run(embInfo.modelId);
      prunedCacheEntries = delInfo.changes || 0;
      cacheDb.exec('DROP TABLE _active_keys;');
      if (prunedCacheEntries > 0) {
        try { cacheDb.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
      }
    }

    // Binäre Vektordateien sauber schließen
    fs.closeSync(fdI8); fdI8 = null;
    fs.closeSync(fdScales); fdScales = null;
    fs.closeSync(fdF32); fdF32 = null;
    cacheDb.close();

    // 4. Metadaten schreiben + FTS5 optimieren + Integrität prüfen
    const buildMs = Date.now() - started;
    const metaPairs = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      policyVersion: POLICY_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      normVersion: NORM_VERSION,
      scannerSignature: screened.scannerSignature,
      canonicalDatabase: database,
      canonicalSeq: collected.canonicalSeq,
      generation,
      modelId: embInfo.modelId,
      modelHash: embInfo.modelHash,
      dimensions: dim,
      dtype: embInfo.dtype,
      queryPrefix: embInfo.queryPrefix,
      passagePrefix: embInfo.passagePrefix,
      sourceCount: totalSourceCount,
      curatedCount,
      archiveCount,
      dbEntryCount: collected.dbEntryCount,
      namespaces: collected.namespaces,
      chunkCount: totalChunks,
      vectorCount: slotCounter,
      excludedCount: screened.excluded.length,
      duplicateDocsMerged: collected.duplicateDocsMerged,
      skipStats: collected.skipStats,
      cacheHits,
      newlyEmbedded,
      builtAt: new Date().toISOString(),
      buildMs
    };

    const putMeta = db.prepare('INSERT INTO index_meta(key, value) VALUES (?, ?)');
    const writeMeta = db.transaction(() => {
      for (const [k, v] of Object.entries(metaPairs)) {
        putMeta.run(k, JSON.stringify(v));
      }
    });
    writeMeta();

    // FTS5 Segmente verdichten & WAL sauber abschließen (wichtig vor read-only Übergabe!)
    db.exec("INSERT INTO fts_main(fts_main) VALUES('optimize');");
    const qc = db.pragma('quick_check', { simple: true });
    if (qc !== 'ok') throw new Error(`PRAGMA quick_check fehlgeschlagen: ${qc}`);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;

    // 5. Atomar an Zielort schieben und optional CURRENT setzen
    if (fs.existsSync(finalDir)) {
      const aside = path.join(indexRoot, `.replaced-${generation}-${process.pid}`);
      fs.renameSync(finalDir, aside);
      fs.renameSync(partialDir, finalDir);
      fs.rmSync(aside, { recursive: true, force: true });
    } else {
      fs.renameSync(partialDir, finalDir);
    }

    if (activate) {
      const tmpCur = path.join(indexRoot, `CURRENT.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
      fs.writeFileSync(tmpCur, generation + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmpCur, path.join(indexRoot, 'CURRENT'));
      cleanupOldGenerations(indexRoot, generation, 2, collected.latestPurgeSeq);
    }

    return { ...metaPairs, prunedCacheEntries };
  } catch (err) {
    if (fdI8 !== null) { try { fs.closeSync(fdI8); } catch { /* ignore */ } }
    if (fdScales !== null) { try { fs.closeSync(fdScales); } catch { /* ignore */ } }
    if (fdF32 !== null) { try { fs.closeSync(fdF32); } catch { /* ignore */ } }
    if (db) { try { db.close(); } catch { /* ignore */ } }
    fs.rmSync(partialDir, { recursive: true, force: true });
    throw err;
  }
  } finally {
    try { cacheDb?.close(); } catch { /* ignore */ }
    releaseLock();
  }
}

function readGenerationCanonicalSeq(genDir) {
  let gdb = null;
  try {
    gdb = new Database(path.join(genDir, 'index.db'), { readonly: true, fileMustExist: true });
    const row = gdb.prepare("SELECT value FROM index_meta WHERE key = 'canonicalSeq'").get();
    return row ? Number(JSON.parse(row.value)) : -1;
  } catch {
    return -1;
  } finally {
    try { gdb?.close(); } catch { /* ignore */ }
  }
}

export function cleanupOldGenerations(indexRoot, activeGen, keepCount = 2, latestPurgeSeq = 0) {
  const dirs = fs.readdirSync(indexRoot)
    .filter((n) => n.startsWith('generation-'))
    .map((n) => ({ name: n, dir: path.join(indexRoot, n), mtime: fs.statSync(path.join(indexRoot, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const keep = new Set([activeGen, ...dirs.slice(0, keepCount).map((d) => d.name)]);
  for (const d of dirs) {
    if (d.name === activeGen) continue;
    // Never retain a prior index generation built before the latest hard purge (may contain purged plaintext!)
    const prePurge = latestPurgeSeq > 0 && readGenerationCanonicalSeq(d.dir) < latestPurgeSeq;
    if (prePurge || !keep.has(d.name)) {
      fs.rmSync(d.dir, { recursive: true, force: true });
    }
  }
}
