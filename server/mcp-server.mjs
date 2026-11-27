#!/usr/bin/env node
// Sonar MCP Server (100 % standalone, zero third-party memory framework dependencies).
// - Einziger kanonischer Schreiber über Unix-Socket (`/run/sonar/mcp.sock`)
// - Alle 11 bisherigen memory_*-Tools abwärtskompatibel + 5 neue P4/Purge-Tools
// - Suche, Embedding und Cross-Encoder laufen im worker_thread (Event-Loop blockiert nie)
// - Beobachtet CURRENT auf neue Index-Generationen der getrennten Reindex-Unit (Hot-Reload ohne Neustart!)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CanonicalStore } from '../core/store/canonical.mjs';
import { expandHome, resolveConfigPaths } from '../core/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPORTED_PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2024-11-05']);

export const TOOL_CATALOGUE = [
  {
    name: 'memory_search_unified',
    description: 'Search across all namespaces (SQLite FTS5 + INT8 vector scan + status redirect + optional local cross-encoder). Returns source IDs and previews; memory_source reads full originals.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (natural language, German/English, ticket IDs, keys)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        namespace: { type: 'string', description: 'Filter to a single namespace' },
        namespaces: { type: 'array', items: { type: 'string' }, description: 'Explicit list of namespaces' },
        project: { type: 'string', description: 'Optional project filter' },
        scope: { type: 'string', enum: ['default', 'archive'], description: 'Include archive tier without downranking when "archive"' },
        rerank: { type: 'string', enum: ['auto', 'off', 'deep'], description: 'Cross-encoder reranking mode (default: auto)' },
        include_history: { type: 'boolean', description: 'Include superseded/archived entries instead of redirecting' },
        threshold: { type: 'number', description: 'Optional minimum semantic similarity' },
        provenance_filter: { type: 'array', items: { type: 'string' }, description: 'Optional provenance filter' }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_search',
    description: 'Alias for memory_search_unified (SQLite FTS5 + INT8 vector scan + status redirect + optional rerank).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        namespace: { type: 'string', description: 'Optional namespace filter' },
        project: { type: 'string', description: 'Optional project filter' },
        threshold: { type: 'number', description: 'Optional minimum semantic similarity' },
        rerank: { type: 'string', enum: ['auto', 'off', 'deep'] },
        include_history: { type: 'boolean' },
        smart: { type: 'boolean', description: 'Compatibility flag; hybrid fusion is always active' }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_store',
    description: 'Store a durable key-value memory entry in canonical SQLite with secret screening and automatic conflict hints.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key (unique within namespace)' },
        value: { description: 'Value to store (string or object)' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
        tags: { type: 'array', items: { type: 'string' } },
        ttl: { type: 'number', description: 'Time-to-live in seconds' },
        upsert: { type: 'boolean', description: 'Update existing key (default: true; false for strict-insert)' },
        provenance_type: { type: 'string', enum: ['user_claim', 'agent_output', 'system_observation', 'tool_result', 'unknown'] },
        kind: { type: 'string', enum: ['rule', 'state', 'pattern', 'event', 'doc'] },
        scope: { type: 'string', description: 'Scope (e.g. global, mac, vps, production)' },
        supersedes: { description: 'Optional old entry ref(s) replaced by this entry' },
        supersede_reason: { type: 'string' },
        created_by: { type: 'string' },
        valid_from: { type: 'number' },
        valid_to: { type: 'number' },
        review_after: { type: 'number' },
        confirm_rule_write: { type: 'boolean', description: 'Required to create or overwrite kind="rule" or provenance_type="user_claim" entries' },
        confirm_rule_supersede: { type: 'boolean', description: 'Required when superseding kind="rule" or provenance_type="user_claim" entries' },
        metadata: { type: 'object', description: 'Optional structured metadata object (max 16 KiB JSON, secret-screened)' }
      },
      required: ['key', 'value']
    }
  },
  {
    name: 'memory_retrieve',
    description: 'Read a stored memory entry by exact (namespace, key) directly from canonical SQLite (never stale).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
        include_history: { type: 'boolean' }
      },
      required: ['key']
    }
  },
  {
    name: 'memory_list',
    description: 'List active memory entries directly from canonical SQLite.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string' },
        limit: { type: 'number', description: 'Max entries (default: 50)' },
        offset: { type: 'number', description: 'Pagination offset (default: 0)' },
        include_history: { type: 'boolean' }
      }
    }
  },
  {
    name: 'memory_delete',
    description: 'Soft-delete a memory entry by exact (namespace, key).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
        confirm_rule_write: { type: 'boolean', description: 'Required to soft-delete kind="rule" or provenance_type="user_claim" entries' }
      },
      required: ['key']
    }
  },
  {
    name: 'memory_source',
    description: 'Read a complete original source by source ID returned from search.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'memory_sources',
    description: 'List indexed original sources and status metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer' },
        limit: { type: 'integer' },
        namespace: { type: 'string' }
      }
    }
  },
  {
    name: 'memory_stats',
    description: 'Return index, vector, RAM and relation/conflict statistics in < 1 ms.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'memory_bridge_status',
    description: 'Compatibility alias for memory_stats.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'memory_import_claude',
    description: 'Report active mirrored Markdown index status (full sources are managed by collector + sonar-reindex).',
    inputSchema: { type: 'object', properties: {} }
  },
  // Punkt 2.3 — Neue Status- & Konflikt-Tools
  {
    name: 'memory_supersede',
    description: 'Mark an older entry as superseded by a newer entry (with cycle check and automatic search redirect).',
    inputSchema: {
      type: 'object',
      properties: {
        old_ref: { type: 'string', description: 'Old entry ID, memory_entries:<id>, or namespace/key' },
        new_ref: { type: 'string', description: 'New active entry ID, memory_entries:<id>, or namespace/key' },
        reason: { type: 'string', description: 'Why the old entry is superseded' },
        created_by: { type: 'string' },
        confirm_rule_supersede: { type: 'boolean', description: 'Required to supersede kind="rule" or provenance_type="user_claim" entries' }
      },
      required: ['old_ref', 'new_ref']
    }
  },
  {
    name: 'memory_flag_conflict',
    description: 'Flag an unresolved contradiction between two entries; search displays both with a conflict warning.',
    inputSchema: {
      type: 'object',
      properties: {
        ref_a: { type: 'string' },
        ref_b: { type: 'string' },
        reason: { type: 'string' },
        created_by: { type: 'string' }
      },
      required: ['ref_a', 'ref_b']
    }
  },
  {
    name: 'memory_resolve',
    description: 'Resolve an open contradiction by declaring the winning reference.',
    inputSchema: {
      type: 'object',
      properties: {
        relation_id: { type: 'number' },
        winner_ref: { type: 'string' },
        reason: { type: 'string' },
        resolved_by: { type: 'string' },
        supersede_loser: { type: 'boolean', description: 'Also mark loser as superseded by winner (default: true)' },
        confirm_rule_supersede: { type: 'boolean', description: 'Required when resolving supersedes a kind="rule" or provenance_type="user_claim" loser' }
      },
      required: ['relation_id', 'winner_ref']
    }
  },
  {
    name: 'memory_history',
    description: 'Inspect relations, active successor chain, and open conflicts for an entry.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref']
    }
  },
  {
    name: 'memory_purge',
    description: 'Hard-delete an entry and its relations for GDPR/secret removal (irreversible).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
        confirm: { type: 'boolean', description: 'Must be true to execute hard purge' },
        confirm_rule_write: { type: 'boolean', description: 'Also required when purging kind="rule" or provenance_type="user_claim" entries' }
      },
      required: ['key', 'confirm']
    }
  }
];

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const TOOL_ANNOTATIONS = {
  memory_search_unified: READ_ONLY_ANNOTATIONS,
  memory_search: READ_ONLY_ANNOTATIONS,
  memory_store: DESTRUCTIVE_ANNOTATIONS,
  memory_retrieve: READ_ONLY_ANNOTATIONS,
  memory_list: READ_ONLY_ANNOTATIONS,
  memory_delete: DESTRUCTIVE_ANNOTATIONS,
  memory_source: READ_ONLY_ANNOTATIONS,
  memory_sources: READ_ONLY_ANNOTATIONS,
  memory_stats: READ_ONLY_ANNOTATIONS,
  memory_bridge_status: READ_ONLY_ANNOTATIONS,
  memory_import_claude: READ_ONLY_ANNOTATIONS,
  memory_supersede: DESTRUCTIVE_ANNOTATIONS,
  memory_flag_conflict: WRITE_ANNOTATIONS,
  memory_resolve: DESTRUCTIVE_ANNOTATIONS,
  memory_history: READ_ONLY_ANNOTATIONS,
  memory_purge: DESTRUCTIVE_ANNOTATIONS
};

for (const tool of TOOL_CATALOGUE) {
  tool.annotations = TOOL_ANNOTATIONS[tool.name] || WRITE_ANNOTATIONS;
}

const TOOL_NAMES = new Set(TOOL_CATALOGUE.map((t) => t.name));

const searchSchema = z.object({
  query: z.string().min(1).max(4096),
  limit: z.number().finite().int().min(1).max(100).optional(),
  namespace: z.string().max(128).optional(),
  namespaces: z.array(z.string().max(128)).max(32).optional(),
  project: z.string().max(256).optional(),
  scope: z.enum(['default', 'archive']).optional(),
  rerank: z.enum(['auto', 'off', 'deep']).optional(),
  rerank_k: z.number().finite().int().min(1).max(50).optional(),
  rerank_timeout_ms: z.number().finite().int().min(50).max(2000).optional(),
  include_history: z.boolean().optional(),
  include_archive: z.boolean().optional(),
  lexical_only: z.boolean().optional(),
  threshold: z.number().finite().min(-1).max(1).optional(),
  provenance_filter: z.array(z.string().max(128)).max(16).optional(),
  smart: z.boolean().optional()
}).passthrough();

const emptySchema = z.object({}).passthrough();

export const TOOL_SCHEMAS = {
  memory_search_unified: searchSchema,
  memory_search: searchSchema,
  memory_store: z.object({
    key: z.string().min(1).max(256),
    value: z.unknown(),
    namespace: z.string().min(1).max(128).optional(),
    tags: z.array(z.string().max(128)).max(64).optional(),
    ttl: z.number().finite().positive().optional(),
    upsert: z.boolean().optional(),
    provenance_type: z.enum(['user_claim', 'agent_output', 'system_observation', 'tool_result', 'unknown']).optional(),
    kind: z.enum(['rule', 'state', 'pattern', 'event', 'doc']).optional(),
    scope: z.string().max(128).optional(),
    supersedes: z.union([z.string().max(512), z.array(z.string().max(512)).max(20)]).optional(),
    supersede_reason: z.string().max(500).optional(),
    created_by: z.string().max(64).optional(),
    valid_from: z.number().finite().optional(),
    valid_to: z.number().finite().nullable().optional(),
    review_after: z.number().finite().nullable().optional(),
    confirm_rule_write: z.boolean().optional(),
    confirm_rule_supersede: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown())
      .refine((m) => JSON.stringify(m).length <= 16384, { message: 'metadata exceeds 16 KiB cap' })
      .optional()
  }).passthrough(),
  memory_retrieve: z.object({
    key: z.string().min(1).max(256),
    namespace: z.string().min(1).max(128).optional(),
    include_history: z.boolean().optional()
  }).passthrough(),
  memory_list: z.object({
    namespace: z.string().max(128).optional(),
    limit: z.number().finite().int().min(1).max(1000).optional(),
    offset: z.number().finite().int().min(0).optional(),
    include_history: z.boolean().optional()
  }).passthrough(),
  memory_delete: z.object({
    key: z.string().min(1).max(256),
    namespace: z.string().min(1).max(128).optional(),
    confirm_rule_write: z.boolean().optional()
  }).passthrough(),
  memory_source: z.object({
    id: z.string().min(1).max(1024)
  }).passthrough(),
  memory_sources: z.object({
    offset: z.number().finite().int().min(0).optional(),
    limit: z.number().finite().int().min(1).max(100).optional(),
    namespace: z.string().max(128).optional()
  }).passthrough(),
  memory_stats: emptySchema,
  memory_bridge_status: emptySchema,
  memory_import_claude: emptySchema,
  memory_supersede: z.object({
    old_ref: z.string().min(1).max(512),
    new_ref: z.string().min(1).max(512),
    reason: z.string().max(500).optional(),
    created_by: z.string().max(64).optional(),
    confirm_rule_supersede: z.boolean().optional()
  }).passthrough(),
  memory_flag_conflict: z.object({
    ref_a: z.string().min(1).max(512),
    ref_b: z.string().min(1).max(512),
    reason: z.string().max(500).optional(),
    created_by: z.string().max(64).optional()
  }).passthrough(),
  memory_resolve: z.object({
    relation_id: z.number().finite().int().positive(),
    winner_ref: z.string().min(1).max(512),
    reason: z.string().max(500).optional(),
    resolved_by: z.string().max(64).optional(),
    supersede_loser: z.boolean().optional(),
    confirm_rule_supersede: z.boolean().optional()
  }).passthrough(),
  memory_history: z.object({
    ref: z.string().min(1).max(512)
  }).passthrough(),
  memory_purge: z.object({
    key: z.string().min(1).max(256),
    namespace: z.string().min(1).max(128).optional(),
    confirm: z.literal(true),
    confirm_rule_write: z.boolean().optional()
  }).passthrough()
};

export class SonarServer {
  constructor(cfg) {
    this.cfg = resolveConfigPaths(cfg);
    // Enforce 0o077 umask BEFORE opening/creating SQLite DB, WAL, SHM, or telemetry files.
    const prevUmask = process.umask(0o077);
    try {
      fs.mkdirSync(path.dirname(this.cfg.database), { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.cfg.index, { recursive: true, mode: 0o700 });
      this.canonical = new CanonicalStore(this.cfg.database, {
        stateRoot: this.cfg.index,
        screenOptions: this.cfg.screenOptions || {},
        allowRuleMutations: this.cfg.allowMcpRuleMutations === true
      });
    } finally {
      process.umask(prevUmask);
    }
    this.worker = null;
    this.closing = false;
    this.workerRespawnTimer = null;
    this.nextReqId = 1;
    this.pending = new Map();
    this.writeChain = Promise.resolve();
    this.loadedGeneration = null;
    this.httpServer = null;
    this.watchTimer = null;
    this.daemonLockPath = null;
    this.telemetryPath = this.cfg.telemetryPath || path.join(this.cfg.index, 'telemetry.jsonl');
    this.telemetryMaxBytes = Number(this.cfg.telemetryMaxBytes || 5 * 1024 * 1024);
  }

  async startWorker() {
    return new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'worker.mjs'), { workerData: this.cfg });
      this.worker = w;
      const onInit = (msg) => {
        if (msg?.type === 'ready') {
          this.loadedGeneration = msg.status?.generation || null;
          w.off('message', onInit);
          w.on('message', (m) => this._onWorkerMessage(m));
          resolve(msg.status);
        }
      };
      w.on('message', onInit);
      w.on('error', (err) => {
        console.error('Sonar worker error:', err.message);
        reject(err);
      });
      w.on('exit', (code) => {
        if (this.worker === w) this.worker = null;
        for (const [, p] of this.pending) p.reject(new Error(`Worker exited with code ${code}`));
        this.pending.clear();
        if (!this.closing && code !== 0) {
          console.error(`Sonar worker exited unexpectedly (code ${code}); respawning...`);
          this.workerRespawnTimer = setTimeout(() => {
            this.workerRespawnTimer = null;
            if (this.closing || this.worker) return;
            this.startWorker().catch((err) => {
              console.error('Sonar worker respawn failed; exiting so supervisor restarts daemon:', err.message);
              process.exit(1);
            });
          }, 500);
          this.workerRespawnTimer.unref();
        }
      });
    });
  }

  _onWorkerMessage(msg) {
    const req = this.pending.get(msg.id);
    if (!req) return;
    this.pending.delete(msg.id);
    if (msg.ok) req.resolve(msg.result);
    else req.reject(new Error(msg.error || 'Worker error'));
  }

  callWorker(action, payload = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.worker) return reject(new Error('Worker not started'));
      const id = this.nextReqId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Worker timeout (${timeoutMs}ms) on ${action}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this.worker.postMessage({ id, action, payload });
    });
  }

  _logTelemetry(entry) {
    try {
      if (fs.existsSync(this.telemetryPath) && fs.statSync(this.telemetryPath).size >= this.telemetryMaxBytes) {
        fs.renameSync(this.telemetryPath, `${this.telemetryPath}.1`);
      }
      fs.appendFileSync(this.telemetryPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
    } catch { /* Telemetrie darf nie Anfragen brechen */ }
  }

  async _checkGenerationReload() {
    try {
      const curPath = path.join(this.cfg.index, 'CURRENT');
      if (!fs.existsSync(curPath)) return;
      const onDisk = fs.readFileSync(curPath, 'utf8').trim();
      if (onDisk && onDisk !== this.loadedGeneration) {
        const st = await this.callWorker('reload', { generation: onDisk });
        this.loadedGeneration = st.generation;
        console.error(`Sonar hot-reloaded generation ${this.loadedGeneration}`);
      }
    } catch (err) {
      console.error('Generation reload check failed:', err.message);
    }
  }

  async callTool(name, rawArgs = {}) {
    const started = performance.now();
    if (!TOOL_NAMES.has(name)) throw new Error(`Unknown tool: ${name}`);
    const schema = TOOL_SCHEMAS[name];
    const parsed = schema ? schema.safeParse(rawArgs ?? {}) : { success: true, data: rawArgs ?? {} };
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
      throw new Error(`Invalid arguments for ${name}: ${msg}`);
    }
    const args = parsed.data;

    if (name === 'memory_search' || name === 'memory_search_unified') {
      const res = await this.callWorker('search', args);
      this._logTelemetry({
        tool: name,
        ms: Math.round(performance.now() - started),
        count: res.count,
        fastPath: res.fastPath || null,
        rerank: res.rerank?.applied || false,
        qLen: String(args.query || '').length
      });
      return res;
    }

    if (name === 'memory_source') {
      return this.callWorker('source', { id: args.id });
    }
    if (name === 'memory_sources') {
      return this.callWorker('sources', args);
    }
    if (name === 'memory_stats' || name === 'memory_bridge_status') {
      return this.callWorker('status', {});
    }
    if (name === 'memory_import_claude') {
      await this._checkGenerationReload();
      const st = await this.callWorker('status', {});
      return { ...st, note: 'Mirrored Markdown sources are indexed by sonar-reindex.service; no truncated reimports.' };
    }
    if (name === 'memory_retrieve') {
      // Stale-Read-Bug behoben: IMMER zuerst kanonische SQLite-DB lesen!
      const live = this.canonical.retrieve(args.namespace || 'default', args.key, { include_history: args.include_history });
      if (live) return live;
      return { found: false, error: 'Not active, absent or excluded from knowledge retrieval' };
    }
    if (name === 'memory_list') {
      return this.canonical.list(args);
    }
    if (name === 'memory_history') {
      return this.canonical.getHistory(args.ref);
    }

    // Schreiboperationen strikt serialisieren (1 Writer)
    const runWrite = async () => {
      if (name === 'memory_store') {
        const valueStr = typeof args.value === 'string' ? args.value : JSON.stringify(args.value);
        // Optionales Embedding + semantische Konfliktprüfung im Worker (blockiert Event-Loop nicht)
        let embRes = { embedding: null, model: null, conflicts: [] };
        try {
          embRes = await this.callWorker('embed_and_conflicts', {
            text: `[${args.namespace || 'default'} › ${args.key}]\n${valueStr.slice(0, 1200)}`,
            namespace: args.namespace || 'default',
            excludeRef: '',
            minSim: 0.85
          }, 10000);
        } catch { /* Schreiben darf auch bei leerem Index nicht scheitern */ }
        const res = this.canonical.store(args, {
          embedding: embRes.embedding,
          embeddingModel: embRes.model,
          semanticConflicts: embRes.conflicts
        });
        this._logTelemetry({ tool: name, ms: Math.round(performance.now() - started), ok: res.success, conflicts: res.possible_conflicts?.length || 0 });
        return res;
      }
      if (name === 'memory_delete') {
        return this.canonical.delete(args.namespace || 'default', args.key, {
          confirm_rule_write: args.confirm_rule_write === true
        });
      }
      if (name === 'memory_purge') {
        if (args.confirm !== true) throw new Error('memory_purge benötigt confirm: true.');
        return this.canonical.purge(args.namespace || 'default', args.key, {
          confirm_rule_write: args.confirm_rule_write === true
        });
      }
      if (name === 'memory_supersede') {
        return this.canonical.supersede(args);
      }
      if (name === 'memory_flag_conflict') {
        return this.canonical.flagConflict(args);
      }
      if (name === 'memory_resolve') {
        return this.canonical.resolveConflict(args);
      }
      throw new Error(`Unhandled write tool: ${name}`);
    };

    const next = this.writeChain.then(runWrite);
    this.writeChain = next.catch(() => {});
    return next;
  }

  async handleRpc(message) {
    const { id, method, params } = message || {};
    if (id === undefined) return null;
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : '2024-11-05';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'sonar', version: '1.0.0' }
        }
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOL_CATALOGUE } };
    if (method === 'tools/call') {
      try {
        const value = await this.callTool(params.name, params.arguments || {});
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(value) }],
            isError: value?.success === false
          }
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
            isError: true
          }
        };
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }

  _validateSocketPath(sock) {
    if (typeof sock !== 'string' || !sock || !path.isAbsolute(sock)) {
      throw new Error(`Invalid socket path (must be an absolute Unix socket path): ${sock}`);
    }
    const parentDir = path.dirname(sock);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    }
    const dirStat = fs.lstatSync(parentDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      throw new Error(`Socket parent must be a real directory (not a symlink): ${parentDir}`);
    }
    if ((dirStat.mode & 0o002) !== 0) {
      throw new Error(`Refusing to bind socket in world-writable directory: ${parentDir}`);
    }
    if (typeof process.getuid === 'function') {
      const uid = process.getuid();
      if (dirStat.uid !== uid && dirStat.uid !== 0) {
        throw new Error(`Socket parent directory not owned by current user or root: ${parentDir}`);
      }
    }
  }

  _acquireDaemonLock() {
    const lockPath = path.join(this.cfg.index, '.daemon.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
        fs.closeSync(fd);
        this.daemonLockPath = lockPath;
        return;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        let alive = false;
        try {
          const pid = Number(fs.readFileSync(lockPath, 'utf8').split('\n')[0]);
          if (pid > 0) {
            try {
              process.kill(pid, 0);
              alive = true;
            } catch (killErr) {
              // EPERM means the process is alive under another UID; only ESRCH confirms it exited.
              alive = killErr?.code !== 'ESRCH';
            }
          }
        } catch { alive = false; }
        if (alive || attempt > 0) {
          throw new Error(`Another Sonar daemon instance holds ${lockPath}`);
        }
        try { fs.unlinkSync(lockPath); } catch { /* race */ }
      }
    }
    throw new Error(`Unable to acquire daemon lock ${lockPath}`);
  }

  _releaseDaemonLock() {
    if (this.daemonLockPath) {
      try { fs.unlinkSync(this.daemonLockPath); } catch { /* ignore */ }
      this.daemonLockPath = null;
    }
  }

  async listen() {
    const sock = this.cfg.socket;
    this._validateSocketPath(sock);
    this._acquireDaemonLock();
    try {
      await this.startWorker();
      if (fs.existsSync(sock)) {
        const st = fs.lstatSync(sock);
        if (!st.isSocket()) {
          throw new Error(`Refusing to unlink non-socket path: ${sock}`);
        }
        fs.unlinkSync(sock);
      }
    } catch (err) {
      this._releaseDaemonLock();
      throw err;
    }
    const prevUmask = process.umask(0o077);

    this.httpServer = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        try {
          const st = await this.callWorker('status', {});
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: st }));
        } catch (err) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err?.message || 'Health check failed' }));
        }
        return;
      }
      if (req.method !== 'POST' || req.url !== '/rpc') {
        res.writeHead(404);
        res.end();
        return;
      }
      try {
        const chunks = [];
        let totalBytes = 0;
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > 3_000_000) throw new Error('Request too large');
          chunks.push(buf);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        const reply = await this.handleRpc(JSON.parse(body));
        res.writeHead(reply ? 200 : 204, { 'content-type': 'application/json' });
        res.end(reply ? JSON.stringify(reply) : '');
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message || 'Invalid request' }));
      }
    });

    const sockMode = this.cfg.socketMode !== undefined ? Number(this.cfg.socketMode) : 0o600;
    try {
      await new Promise((resolve, reject) => {
        this.httpServer.once('error', reject);
        this.httpServer.listen(sock, () => {
          fs.chmodSync(sock, sockMode);
          console.error(`Sonar MCP socket ready at ${sock}`);
          resolve();
        });
      });
    } catch (err) {
      this._releaseDaemonLock();
      throw err;
    } finally {
      process.umask(prevUmask);
    }

    this.watchTimer = setInterval(() => { this._checkGenerationReload(); }, 5000);
    this.watchTimer.unref();
  }

  async close() {
    this.closing = true;
    if (this.workerRespawnTimer) clearTimeout(this.workerRespawnTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(() => resolve()));
    }
    if (this.worker) await this.worker.terminate();
    this.canonical.close();
    this._releaseDaemonLock();
  }
}

// Direkter Start über CLI / systemd
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfgPath = expandHome(process.argv[2] || process.env.SONAR_CONFIG || '/etc/sonar/config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const srv = new SonarServer(cfg);
  await srv.listen();
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
