// Standalone SQLite canonical writer (zero third-party memory framework dependencies).
// Behebt den Stale-Read-Bug (memory_retrieve liest IMMER zuerst die kanonische DB),
// führt status/memory_relations (superseded & contradicted), changes(seq) Journal und hartes Purge.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureCanonicalSchema } from './migrations.mjs';
import { screenSingleWrite } from '../secret-screen.mjs';
import { normalizeText } from '../normalize.mjs';

const VALID_PROVENANCE = new Set(['user_claim', 'agent_output', 'system_observation', 'tool_result', 'unknown']);
const VALID_KINDS = new Set(['rule', 'state', 'pattern', 'event', 'doc']);
const DANGEROUS_KEY_RE = /[\x00-\x1f\x7f\\;|&$`<>]/;
const MAX_REASON_CHARS = 500;
const MAX_SCOPE_CHARS = 128;

function sanitizeReason(reason) {
  const s = String(reason || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (s.length > MAX_REASON_CHARS) {
    throw new Error(`Ungültiger reason (max. ${MAX_REASON_CHARS} Zeichen).`);
  }
  return s;
}

function validateKeyNs(key, namespace) {
  if (!key || typeof key !== 'string' || key.length > 256 || DANGEROUS_KEY_RE.test(key)) {
    throw new Error('Ungültiger key (leer, zu lang oder unerlaubte Zeichen).');
  }
  if (!namespace || typeof namespace !== 'string' || namespace.length > 128 || DANGEROUS_KEY_RE.test(namespace)) {
    throw new Error('Ungültiger namespace.');
  }
}

export function normalizeRef(ref) {
  const s = String(ref || '').trim();
  if (!s) return '';
  if (s.startsWith('memory_entries:') || s.startsWith('markdown:') || s.startsWith('entry_')) {
    return s.startsWith('entry_') ? `memory_entries:${s}` : s;
  }
  return s;
}

export class CanonicalStore {
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.stateRoot = options.stateRoot || path.dirname(path.resolve(dbPath));
    this.screenOptions = options.screenOptions || {};
    this.db = new Database(dbPath);
    ensureCanonicalSchema(this.db);
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  latestSeq() {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM sonar_changes').get();
    return r.seq;
  }

  _logChange(ref, op, detail = null) {
    const info = this.db.prepare(
      'INSERT INTO sonar_changes(ref, op, detail, ts) VALUES (?, ?, ?, ?)'
    ).run(ref, op, detail ? JSON.stringify(detail) : null, Date.now());
    return Number(info.lastInsertRowid);
  }

  /**
   * Eigenständiges `memory_store` mit voller Abwärtskompatibilität zu allen 11 MCP-Verträgen
   * plus optionalem `supersedes`, `kind`, `valid_from`, `valid_to`, `review_after`, `scope`
   * und automatischer Konfliktprüfung (`possible_conflicts`).
   */
  store(input, hooks = {}) {
    const key = String(input.key || '').trim();
    const namespace = String(input.namespace || 'default').trim();
    validateKeyNs(key, namespace);

    const rawVal = input.value;
    const content = typeof rawVal === 'string' ? rawVal : (rawVal !== undefined ? JSON.stringify(rawVal) : '');
    if (!content || content.length > 2_000_000) {
      throw new Error('Value fehlt oder überschreitet 2 MB.');
    }

    const provenance = input.provenance_type || 'unknown';
    if (!VALID_PROVENANCE.has(provenance)) {
      throw new Error(`Ungültiger provenance_type "${provenance}".`);
    }

    const kind = input.kind || (namespace === 'patterns' ? 'pattern' : 'doc');
    if (!VALID_KINDS.has(kind)) {
      throw new Error(`Ungültiger kind "${kind}".`);
    }

    // Secret-Screening (Gitleaks mit Regelversion)
    if (!hooks.skipSecretScreen) {
      const check = screenSingleWrite(key, content, this.stateRoot, this.screenOptions);
      if (check.blocked) {
        throw new Error('Possible credential detected: use the secret store, not knowledge memory');
      }
    }

    const upsert = input.upsert !== false;
    const now = Date.now();
    const expiresAt = typeof input.ttl === 'number' && input.ttl > 0 ? now + Math.round(input.ttl * 1000) : null;
    const tagsJson = JSON.stringify(Array.isArray(input.tags) ? input.tags : []);
    const metadataObj = (input.metadata && typeof input.metadata === 'object') ? input.metadata : {};
    const metadataJson = JSON.stringify(metadataObj);
    const validFrom = input.valid_from ?? now;
    const validTo = input.valid_to ?? null;
    const reviewAfter = input.review_after ?? null;
    const scope = String(input.scope || 'global').trim();
    if (scope.length > MAX_SCOPE_CHARS || DANGEROUS_KEY_RE.test(scope)) {
      throw new Error(`Ungültiger scope (max. ${MAX_SCOPE_CHARS} Zeichen, keine Steuerzeichen).`);
    }
    const embeddingArr = hooks.embedding ? Array.from(hooks.embedding) : null;
    const embeddingJson = embeddingArr ? JSON.stringify(embeddingArr) : null;
    const embeddingModel = hooks.embeddingModel || 'sonar-pending';
    const embeddingDim = embeddingArr ? embeddingArr.length : null;

    // Existierende Zeile prüfen (inkl. strict-insert und Tombstone-Wiederbelebung)
    const existing = this.db.prepare(
      'SELECT id, status, created_at FROM memory_entries WHERE namespace = ? AND key = ?'
    ).get(namespace, key);

    if (existing && !upsert && existing.status === 'active') {
      return {
        success: false,
        key,
        namespace,
        error: `Entry "${namespace}/${key}" already exists (pass upsert: true to update)`
      };
    }

    const entryId = existing?.id || `entry_${now}_${crypto.randomBytes(8).toString('hex')}`;
    const ref = `memory_entries:${entryId}`;

    const tx = this.db.transaction(() => {
      if (existing) {
        this.db.prepare(`
          UPDATE memory_entries SET
            content = ?,
            embedding = COALESCE(?, embedding),
            embedding_model = COALESCE(?, embedding_model),
            embedding_dimensions = COALESCE(?, embedding_dimensions),
            tags = ?,
            metadata = ?,
            updated_at = ?,
            expires_at = ?,
            status = 'active',
            provenance_type = ?,
            kind = ?,
            valid_from = ?,
            valid_to = ?,
            review_after = ?,
            scope = ?,
            superseded_by = NULL
          WHERE id = ?
        `).run(
          content, embeddingJson, embeddingModel, embeddingDim,
          tagsJson, metadataJson, now, expiresAt,
          provenance, kind, validFrom, validTo, reviewAfter, scope,
          entryId
        );
        // Dismiss any previously resolved incoming `supersedes` edges so the re-activated entry stops redirecting to an old successor
        this.db.prepare(
          "UPDATE memory_relations SET state = 'dismissed' WHERE to_ref = ? AND type = 'supersedes' AND state != 'dismissed'"
        ).run(ref);
      } else {
        this.db.prepare(`
          INSERT INTO memory_entries (
            id, key, namespace, content, type,
            embedding, embedding_dimensions, embedding_model,
            tags, metadata, provenance_type,
            created_at, updated_at, expires_at, status,
            kind, valid_from, valid_to, review_after, scope
          ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
        `).run(
          entryId, key, namespace, content,
          embeddingJson, embeddingDim, embeddingModel,
          tagsJson, metadataJson, provenance,
          now, now, expiresAt,
          kind, validFrom, validTo, reviewAfter, scope
        );
      }

      // Falls explizite `supersedes`-IDs mitgesendet wurden, sofort in derselben Transaktion verknüpfen
      const supersedesList = Array.isArray(input.supersedes)
        ? input.supersedes
        : (typeof input.supersedes === 'string' && input.supersedes ? [input.supersedes] : []);
      const cleanReason = sanitizeReason(input.supersede_reason || 'Replaced by newer memory_store');
      if (cleanReason && !hooks.skipSecretScreen) {
        const rc = screenSingleWrite('supersede-reason', cleanReason, this.stateRoot, this.screenOptions);
        if (rc.blocked) throw new Error('Possible credential detected in supersede_reason');
      }
      for (const oldRaw of supersedesList) {
        this._linkSupersedesTx(ref, this._resolveRefInput(oldRaw), cleanReason, input.created_by || 'agent');
      }

      const seq = this._logChange(ref, 'upsert', { key, namespace, kind, scope });
      return seq;
    });

    const seq = tx();

    // Konfliktkandidaten (Key-Präfix + optional semantische Kandidaten aus hooks.findSimilar)
    const possibleConflicts = this._findKeyConflicts(namespace, key, entryId);
    if (Array.isArray(hooks.semanticConflicts)) {
      const seen = new Set(possibleConflicts.map((c) => c.id));
      for (const sc of hooks.semanticConflicts) {
        if (sc.id !== ref && !seen.has(sc.id)) {
          possibleConflicts.push(sc);
          seen.add(sc.id);
        }
      }
    }

    return {
      success: true,
      id: entryId,
      ref,
      key,
      namespace,
      kind,
      scope,
      seq,
      stored: true,
      storedAt: new Date(now).toISOString(),
      hasEmbedding: Boolean(embeddingArr),
      embeddingDimensions: embeddingDim,
      provenanceType: provenance,
      backend: 'sonar-sqlite-canonical',
      possible_conflicts: possibleConflicts.length ? possibleConflicts.slice(0, 5) : undefined,
      conflict_hint: possibleConflicts.length
        ? 'Ähnliche aktive Einträge gefunden. Falls derselbe Sachverhalt ersetzt wird: memory_supersede aufrufen.'
        : undefined
    };
  }

  _findKeyConflicts(namespace, key, excludeId) {
    const norm = normalizeText(key);
    const prefix = norm.split(/[-_]/).slice(0, 3).join('-');
    if (prefix.length < 6) return [];
    const rows = this.db.prepare(`
      SELECT id, key, namespace, substr(content, 1, 180) AS preview, updated_at
      FROM memory_entries
      WHERE namespace = ? AND status = 'active' AND id != ? AND lower(key) LIKE ?
      ORDER BY updated_at DESC LIMIT 5
    `).all(namespace, excludeId, `${prefix}%`);
    return rows.map((r) => ({
      id: `memory_entries:${r.id}`,
      key: r.key,
      namespace: r.namespace,
      match: 'key-prefix',
      updatedAt: new Date(r.updated_at).toISOString(),
      preview: r.preview
    }));
  }

  /**
   * Direktabruf: liest IMMER zuerst aus der kanonischen SQLite-DB (behebt Stale-Read-Bug!).
   * Zeigt bei einem ersetzten Eintrag automatisch den aktiven Nachfolger an.
   */
  retrieve(namespace, key, options = {}) {
    const ns = String(namespace || 'default');
    const row = this.db.prepare(`
      SELECT id, key, namespace, content, tags, metadata, status, kind, scope,
             provenance_type, created_at, updated_at, expires_at, valid_from, valid_to, review_after, superseded_by
      FROM memory_entries
      WHERE namespace = ? AND key = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(ns, key);

    if (!row) return null;
    const now = Date.now();
    if (row.expires_at && row.expires_at <= now && !options.include_history) return null;
    if (row.status === 'deleted' && !options.include_history) return null;

    const ref = `memory_entries:${row.id}`;
    const successor = this.resolveActiveSuccessor(ref);
    const conflicts = this.getOpenConflictsFor(ref);

    let parsedValue = row.content;
    try { parsedValue = JSON.parse(row.content); } catch { /* Klartext belassen */ }

    return {
      found: true,
      id: ref,
      key: row.key,
      namespace: row.namespace,
      value: parsedValue,
      status: row.status || 'active',
      kind: row.kind || 'pattern',
      scope: row.scope || 'global',
      provenance: row.provenance_type || 'unknown',
      updatedAt: row.updated_at,
      source: `sonar://memory_entries/${row.id}`,
      superseded_by: successor ? successor.target : (row.superseded_by || null),
      successor_notice: successor ? `Überholt: ${ref} → aktuell ${successor.target}${successor.reason ? ' (' + successor.reason + ')' : ''}` : undefined,
      open_conflicts: conflicts.length ? conflicts : undefined
    };
  }

  retrieveById(idOrRef, options = {}) {
    const rawId = String(idOrRef || '').replace(/^memory_entries:/, '');
    const row = this.db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(rawId);
    if (!row) return null;
    return this.retrieve(row.namespace, row.key, { include_history: options.include_history === true });
  }

  list({ namespace = null, limit = 50, offset = 0, include_history = false } = {}) {
    const now = Date.now();
    const where = [];
    const params = [];
    if (namespace) { where.push('namespace = ?'); params.push(namespace); }
    if (!include_history) {
      where.push("(status IS NULL OR status = 'active')");
      where.push('(expires_at IS NULL OR expires_at > ?)');
      params.push(now);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT count(*) AS n FROM memory_entries ${whereSql}`).get(...params).n;
    const rows = this.db.prepare(`
      SELECT id, key, namespace, content, status, kind, scope, updated_at, superseded_by
      FROM memory_entries ${whereSql}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Math.min(1000, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));

    return {
      entries: rows.map((r) => ({
        id: `memory_entries:${r.id}`,
        key: r.key,
        namespace: r.namespace,
        value: r.content,
        status: r.status || 'active',
        kind: r.kind || 'pattern',
        updatedAt: r.updated_at,
        superseded_by: r.superseded_by || undefined
      })),
      total
    };
  }

  /**
   * Weiches Löschen (kompatibel zu `memory_delete`: setzt status='deleted' für Tombstone-Schutz).
   */
  delete(namespace, key) {
    const ns = String(namespace || 'default');
    const row = this.db.prepare(
      "SELECT id FROM memory_entries WHERE namespace = ? AND key = ? AND (status IS NULL OR status != 'deleted')"
    ).get(ns, key);
    if (!row) {
      const rem = this.db.prepare("SELECT count(*) AS n FROM memory_entries WHERE status = 'active'").get().n;
      return { success: false, deleted: false, key, namespace: ns, remainingEntries: rem, error: 'Entry not found' };
    }
    const ref = `memory_entries:${row.id}`;
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE memory_entries SET status = 'deleted', updated_at = ? WHERE id = ?").run(Date.now(), row.id);
      this.db.prepare(
        "UPDATE memory_relations SET state = 'dismissed' WHERE type = 'contradicts' AND state = 'open' AND (from_ref = ? OR to_ref = ?)"
      ).run(ref, ref);
      this._logChange(ref, 'delete', { key, namespace: ns });
    });
    tx();
    const rem = this.db.prepare("SELECT count(*) AS n FROM memory_entries WHERE status = 'active'").get().n;
    return {
      success: true,
      deleted: true,
      key,
      namespace: ns,
      remainingEntries: rem,
      backend: 'sonar-sqlite-canonical'
    };
  }

  /**
   * Hartes DSGVO-/Secret-Purge: löscht Zeile, Relationen, überschreibt Detail-Logs,
   * schreibt ein minimales `purge`-Tombstone ins Journal, leert das WAL und entfernt
   * ältere Backup-Indexgenerationen auf der Platte.
   */
  purge(namespace, key) {
    const ns = String(namespace || 'default');
    const row = this.db.prepare('SELECT id FROM memory_entries WHERE namespace = ? AND key = ?').get(ns, key);
    if (!row) return { success: false, purged: false, key, namespace: ns };
    const ref = `memory_entries:${row.id}`;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_relations WHERE from_ref = ? OR to_ref = ?').run(ref, ref);
      this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(row.id);
      this.db.prepare('UPDATE sonar_changes SET detail = NULL WHERE ref = ?').run(ref);
      this._logChange(ref, 'purge', { purged: true });
    });
    tx();
    let walCheckpointBusy = false;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = this.db.pragma('wal_checkpoint(TRUNCATE)');
        const row = Array.isArray(res) ? res[0] : res;
        walCheckpointBusy = Boolean(row && row.busy);
        if (!walCheckpointBusy) break;
      }
    } catch { walCheckpointBusy = true; }

    let removedOldGenerations = 0;
    try {
      if (this.stateRoot && fs.existsSync(this.stateRoot)) {
        const curFile = path.join(this.stateRoot, 'CURRENT');
        const activeGen = fs.existsSync(curFile) ? fs.readFileSync(curFile, 'utf8').trim() : '';
        for (const name of fs.readdirSync(this.stateRoot)) {
          if (name.startsWith('generation-') && name !== activeGen) {
            fs.rmSync(path.join(this.stateRoot, name), { recursive: true, force: true });
            removedOldGenerations++;
          }
        }
      }
    } catch { /* best-effort cleanup of older generations */ }

    return {
      success: true,
      purged: true,
      ref,
      key,
      namespace: ns,
      removedOldGenerations,
      walCheckpointBusy,
      note: 'Entry purged from canonical SQLite and blocked from search/source immediately. Run reindex --force to scrub the active read-only index snapshot and orphaned vector cache entries.'
    };
  }

  // --- Punkt 2.3: Relationen (`supersedes`, `contradicts`, `resolve`, `history`) ---

  _resolveRefInput(refOrKey, defaultNamespace = 'patterns') {
    const s = String(refOrKey || '').trim();
    if (!s) throw new Error('Referenz fehlt.');
    if (s.startsWith('memory_entries:') || s.startsWith('markdown:')) return s;
    if (s.startsWith('entry_')) return `memory_entries:${s}`;
    // Suche nach namespace/key oder bloßem key
    const slash = s.indexOf('/');
    const row = slash > 0
      ? this.db.prepare('SELECT id FROM memory_entries WHERE namespace = ? AND key = ?').get(s.slice(0, slash), s.slice(slash + 1))
      : this.db.prepare('SELECT id FROM memory_entries WHERE key = ? ORDER BY (namespace = ?) DESC, updated_at DESC LIMIT 1').get(s, defaultNamespace);
    if (row) return `memory_entries:${row.id}`;
    return s;
  }

  _hasSupersedesCycle(newRef, oldRef) {
    if (newRef === oldRef) return true;
    // Prüfe, ob oldRef (direkt oder transitiv) bereits newRef ersetzt
    const visited = new Set([oldRef]);
    let cur = [oldRef];
    for (let depth = 0; depth < 8 && cur.length; depth++) {
      const next = [];
      for (const node of cur) {
        const rows = this.db.prepare(
          "SELECT to_ref FROM memory_relations WHERE from_ref = ? AND type = 'supersedes' AND state != 'dismissed'"
        ).all(node);
        for (const r of rows) {
          if (r.to_ref === newRef) return true;
          if (!visited.has(r.to_ref)) {
            visited.add(r.to_ref);
            next.push(r.to_ref);
          }
        }
      }
      cur = next;
    }
    return false;
  }

  _linkSupersedesTx(newRef, oldRef, reason = '', createdBy = 'agent') {
    // Only canonical `memory_entries:*` entries may be superseded via MCP tools;
    // prevents cross-trust hijacking of `own-rule`/Markdown sources or blackholing via bogus target refs.
    if (!oldRef.startsWith('memory_entries:') || !newRef.startsWith('memory_entries:')) {
      throw new Error('MCP supersedes only supports canonical memory_entries references (cannot override external/own-rule Markdown sources).');
    }
    const oldId = oldRef.slice('memory_entries:'.length);
    const newId = newRef.slice('memory_entries:'.length);
    const oldRow = this.db.prepare('SELECT id, status FROM memory_entries WHERE id = ?').get(oldId);
    if (!oldRow || oldRow.status === 'deleted') {
      throw new Error(`old_ref nicht gefunden oder gelöscht: ${oldRef}`);
    }
    const newRow = this.db.prepare('SELECT id, status, expires_at FROM memory_entries WHERE id = ?').get(newId);
    if (!newRow || newRow.status === 'deleted') {
      throw new Error(`new_ref nicht gefunden oder gelöscht: ${newRef}`);
    }
    if (this._hasSupersedesCycle(newRef, oldRef)) {
      throw new Error(`Zyklische Ersetzung verweigert: ${newRef} -> ${oldRef}`);
    }
    if ((newRow.status && newRow.status !== 'active') || (newRow.expires_at && newRow.expires_at <= Date.now())) {
      throw new Error(`new_ref nicht aktiv: ${newRef}`);
    }
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memory_relations(from_ref, to_ref, type, state, reason, created_by, created_at)
      VALUES (?, ?, 'supersedes', 'resolved', ?, ?, ?)
      ON CONFLICT(from_ref, to_ref, type) DO UPDATE SET
        state = 'resolved', reason = excluded.reason, created_by = excluded.created_by
    `).run(newRef, oldRef, String(reason || ''), String(createdBy || 'agent').slice(0, 64), now);

    this.db.prepare(`
      UPDATE memory_entries SET status = 'archived', superseded_by = ?, updated_at = ?
      WHERE id = ?
    `).run(newRef, now, oldId);
  }

  _screenReason(reason, label = 'relation-reason') {
    const clean = sanitizeReason(reason);
    if (clean) {
      const check = screenSingleWrite(label, clean, this.stateRoot, this.screenOptions);
      if (check.blocked) {
        throw new Error(`Possible credential detected in ${label}`);
      }
    }
    return clean;
  }

  supersede({ old_ref, new_ref, reason = '', created_by = 'agent' }) {
    const oldRef = this._resolveRefInput(old_ref);
    const newRef = this._resolveRefInput(new_ref);
    const cleanReason = this._screenReason(reason, 'supersede-reason');
    const tx = this.db.transaction(() => {
      this._linkSupersedesTx(newRef, oldRef, cleanReason, created_by);
      return this._logChange(oldRef, 'status', { action: 'supersede', oldRef, newRef, reason: cleanReason });
    });
    const seq = tx();
    return { success: true, old_ref: oldRef, new_ref: newRef, reason: cleanReason, seq };
  }

  flagConflict({ ref_a, ref_b, reason = '', created_by = 'agent' }) {
    const a = this._resolveRefInput(ref_a);
    const b = this._resolveRefInput(ref_b);
    if (a === b) throw new Error('Konflikt braucht zwei verschiedene Referenzen.');
    if (!a.startsWith('memory_entries:') || !b.startsWith('memory_entries:')) {
      throw new Error('MCP flagConflict only supports canonical memory_entries references (cannot annotate external/own-rule Markdown sources).');
    }
    const now = Date.now();
    for (const ref of [a, b]) {
      const id = ref.slice('memory_entries:'.length);
      const row = this.db.prepare('SELECT id, status, expires_at FROM memory_entries WHERE id = ?').get(id);
      if (!row || (row.status && row.status !== 'active') || (row.expires_at && row.expires_at <= now)) {
        throw new Error(`Referenz nicht gefunden oder nicht aktiv: ${ref}`);
      }
    }
    const cleanReason = this._screenReason(reason, 'conflict-reason');
    const [fromRef, toRef] = a < b ? [a, b] : [b, a];
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO memory_relations(from_ref, to_ref, type, state, reason, created_by, created_at)
        VALUES (?, ?, 'contradicts', 'open', ?, ?, ?)
        ON CONFLICT(from_ref, to_ref, type) DO UPDATE SET
          state = 'open', reason = excluded.reason, created_by = excluded.created_by
      `).run(fromRef, toRef, cleanReason, String(created_by || 'agent').slice(0, 64), now);
      const rel = this.db.prepare(
        "SELECT id FROM memory_relations WHERE from_ref = ? AND to_ref = ? AND type = 'contradicts'"
      ).get(fromRef, toRef);
      const seq = this._logChange(fromRef, 'relation', { action: 'contradicts', fromRef, toRef, relationId: rel.id });
      return { id: rel.id, seq };
    });
    const res = tx();
    return { success: true, relation_id: res.id, ref_a: fromRef, ref_b: toRef, state: 'open', reason: cleanReason, seq: res.seq };
  }

  resolveConflict({ relation_id, winner_ref, reason = '', resolved_by = 'agent', supersede_loser = true }) {
    const rel = this.db.prepare('SELECT * FROM memory_relations WHERE id = ?').get(Number(relation_id));
    if (!rel) throw new Error(`Relation #${relation_id} nicht gefunden.`);
    const winner = this._resolveRefInput(winner_ref);
    if (winner !== rel.from_ref && winner !== rel.to_ref) {
      throw new Error(`winner_ref (${winner}) gehört nicht zu Relation #${relation_id} (${rel.from_ref} vs ${rel.to_ref}).`);
    }
    const loser = winner === rel.from_ref ? rel.to_ref : rel.from_ref;
    const cleanReason = this._screenReason(reason, 'resolve-reason');
    const now = Date.now();
    const loserRow = loser.startsWith('memory_entries:')
      ? this.db.prepare('SELECT status FROM memory_entries WHERE id = ?').get(loser.slice('memory_entries:'.length))
      : null;
    const canSupersedeLoser = Boolean(
      supersede_loser && winner.startsWith('memory_entries:') && loser.startsWith('memory_entries:') && loserRow && loserRow.status !== 'deleted'
    );
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE memory_relations SET state = 'resolved', winner_ref = ?, resolved_at = ?, resolved_by = ?, reason = COALESCE(NULLIF(?, ''), reason)
        WHERE id = ?
      `).run(winner, now, String(resolved_by).slice(0, 64), cleanReason, rel.id);
      if (canSupersedeLoser) {
        this._linkSupersedesTx(winner, loser, cleanReason || `Konflikt #${rel.id} entschieden`, resolved_by);
      }
      return this._logChange(winner, 'relation', { action: 'resolve', relationId: rel.id, winner, loser });
    });
    const seq = tx();
    return { success: true, relation_id: rel.id, winner_ref: winner, loser_ref: loser, superseded_loser: canSupersedeLoser, seq };
  }

  /**
   * Löst eine eindeutige `supersedes`-Kette bis Tiefe 3 zum aktiven kanonischen Nachfolger auf.
   * Bei Zyklus, Verzweigung, fehlendem/inaktivem Ziel oder externen Referenzen gibt es null zurück.
   */
  resolveActiveSuccessor(ref, maxDepth = 3) {
    const start = normalizeRef(ref);
    if (!start.startsWith('memory_entries:')) return null;
    let current = start;
    const visited = new Set([current]);
    let lastReason = '';
    for (let step = 0; step < maxDepth; step++) {
      const incoming = this.db.prepare(
        "SELECT from_ref, reason FROM memory_relations WHERE to_ref = ? AND type = 'supersedes' AND state != 'dismissed'"
      ).all(current);
      if (incoming.length === 0) break;
      if (incoming.length > 1) return null; // Verzweigung → keine automatische Umleitung
      const next = incoming[0].from_ref;
      if (!next.startsWith('memory_entries:')) return null;
      if (visited.has(next)) return null; // Zyklus
      visited.add(next);
      lastReason = incoming[0].reason || lastReason;
      current = next;
    }
    if (current === start) return null;
    const row = this.db.prepare('SELECT status, expires_at FROM memory_entries WHERE id = ?').get(current.slice('memory_entries:'.length));
    if (!row || (row.status && row.status !== 'active') || (row.expires_at && row.expires_at <= Date.now())) {
      return null;
    }
    return { target: current, reason: lastReason, hops: visited.size - 1 };
  }

  getOpenConflictsFor(ref) {
    const r = normalizeRef(ref);
    return this.db.prepare(`
      SELECT id, from_ref, to_ref, reason, created_at, created_by
      FROM memory_relations
      WHERE type = 'contradicts' AND state = 'open' AND (from_ref = ? OR to_ref = ?)
    `).all(r, r).map((row) => ({
      relation_id: row.id,
      other_ref: row.from_ref === r ? row.to_ref : row.from_ref,
      reason: row.reason,
      since: new Date(row.created_at).toISOString()
    }));
  }

  getHistory(refOrKey) {
    const ref = this._resolveRefInput(refOrKey);
    const relations = this.db.prepare(`
      SELECT * FROM memory_relations WHERE from_ref = ? OR to_ref = ? ORDER BY created_at DESC
    `).all(ref, ref);
    const entry = ref.startsWith('memory_entries:') ? this.retrieveById(ref, { include_history: true }) : null;
    const activeSuccessor = this.resolveActiveSuccessor(ref);
    return {
      ref,
      entry,
      active_successor: activeSuccessor,
      relations
    };
  }

  /**
   * Liefert eine kompakte Live-Snapshot-Map aller Status/Relationen für die Suchpipeline (O(1) Lookup!).
   */
  loadStatusOverlay() {
    const deleted = new Set();
    const purged = new Set();
    const superseded = new Map();
    const conflicts = new Map();

    for (const r of this.db.prepare("SELECT DISTINCT ref FROM sonar_changes WHERE op = 'purge'").all()) {
      purged.add(r.ref);
      deleted.add(r.ref);
    }

    const now = Date.now();
    for (const r of this.db.prepare(
      "SELECT id, status, superseded_by, expires_at FROM memory_entries WHERE status != 'active' OR superseded_by IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?)"
    ).all(now)) {
      const ref = `memory_entries:${r.id}`;
      if (r.status === 'deleted' || (r.expires_at && r.expires_at <= now)) deleted.add(ref);
      else if (r.status === 'archived' || r.superseded_by) {
        const succ = this.resolveActiveSuccessor(ref);
        if (succ) superseded.set(ref, succ);
        else deleted.add(ref);
      }
    }

    for (const r of this.db.prepare("SELECT to_ref FROM memory_relations WHERE type = 'supersedes' AND state != 'dismissed'").all()) {
      if (!superseded.has(r.to_ref) && !purged.has(r.to_ref)) {
        const succ = this.resolveActiveSuccessor(r.to_ref);
        if (succ) superseded.set(r.to_ref, succ);
      }
    }

    const openConflictRows = this.db.prepare(
      "SELECT id, from_ref, to_ref, reason, created_at FROM memory_relations WHERE type = 'contradicts' AND state = 'open'"
    ).all();
    let activeConflictCount = 0;
    for (const row of openConflictRows) {
      if (deleted.has(row.from_ref) || deleted.has(row.to_ref) || purged.has(row.from_ref) || purged.has(row.to_ref)) {
        continue;
      }
      activeConflictCount++;
      const add = (a, b) => {
        if (!conflicts.has(a)) conflicts.set(a, []);
        conflicts.get(a).push({ relation_id: row.id, other_ref: b, reason: row.reason, since: new Date(row.created_at).toISOString() });
      };
      add(row.from_ref, row.to_ref);
      add(row.to_ref, row.from_ref);
    }

    return {
      deleted,
      purged,
      superseded,
      conflicts,
      openConflictCount: activeConflictCount,
      supersededCount: superseded.size
    };
  }

  /**
   * Liefert aktive DB-Einträge, die seit der letzten Index-Generation (`sinceSeq`) neu angelegt oder geändert wurden.
   * Ermöglicht sofortige Sichtbarkeit in `memory_search_unified` ohne Warten auf Reindex!
   */
  getDeltaEntriesSince(sinceSeq = 0) {
    const refs = this.db.prepare(
      "SELECT DISTINCT ref FROM sonar_changes WHERE seq > ? AND op = 'upsert' AND ref LIKE 'memory_entries:%'"
    ).all(Number(sinceSeq) || 0);
    if (!refs.length) return [];
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT id, key, namespace, content, status, kind, scope, provenance_type, updated_at, expires_at, superseded_by
      FROM memory_entries WHERE id = ?
    `);
    const out = [];
    for (const { ref } of refs) {
      const rawId = ref.slice('memory_entries:'.length);
      const r = stmt.get(rawId);
      if (!r || r.status === 'deleted' || (r.status !== 'active' && !r.superseded_by) || (r.expires_at && r.expires_at <= now)) continue;
      out.push({
        source_id: ref,
        id: ref,
        key: r.key,
        namespace: r.namespace,
        project: '',
        uri: `sonar://memory_entries/${r.id}`,
        hash: '',
        updated: r.updated_at || now,
        status: r.status,
        kind: r.kind || (r.namespace === 'patterns' ? 'pattern' : 'doc'),
        trust: 'internal-memory',
        tier: 'curated',
        provenance: r.provenance_type || 'unknown',
        superseded_by: r.superseded_by || null,
        start_off: 0,
        end_off: (r.content || '').length,
        header: `[${r.namespace} › ${r.key}]\n`,
        raw_text: r.content || '',
        text_len: (r.content || '').length
      });
    }
    return out;
  }

  relationStats() {
    const openConflicts = this.db.prepare(
      "SELECT count(*) AS n, MIN(created_at) AS oldest FROM memory_relations WHERE type = 'contradicts' AND state = 'open'"
    ).get();
    const supersedes = this.db.prepare(
      "SELECT count(*) AS n FROM memory_relations WHERE type = 'supersedes' AND state != 'dismissed'"
    ).get();
    const archivedEntries = this.db.prepare(
      "SELECT count(*) AS n FROM memory_entries WHERE status = 'archived'"
    ).get();
    return {
      openConflicts: openConflicts.n,
      oldestOpenConflict: openConflicts.oldest ? new Date(openConflicts.oldest).toISOString() : null,
      supersedesRelations: supersedes.n,
      archivedEntries: archivedEntries.n
    };
  }
}
