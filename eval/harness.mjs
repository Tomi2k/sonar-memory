#!/usr/bin/env node
// P0/P1/P2/P5/P6 Eval-Harness:
// Misst nDCG@5, nDCG@10, Recall@10, Recall@20, Exact@1, p50, p95 und RSS
// sowohl gegen den laufenden Legacy-Socket (--mode legacy-socket) als auch direkt gegen eine Sonar-Generation (--mode sonar).
import fs from 'node:fs';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { OfflineEmbedder } from '../core/embedder.mjs';
import { OfflineReranker } from '../core/reranker.mjs';
import { CanonicalStore } from '../core/store/canonical.mjs';
import { SearchEngine } from '../core/search/engine.mjs';
import { expandHome, resolveConfigPaths } from '../core/paths.mjs';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
};

const queriesPath = expandHome(flag('--queries', fileURLToPath(new URL('../examples/queries.example.json', import.meta.url))));
const mode = flag('--mode', 'sonar'); // 'legacy-socket' | 'sonar'
const outPath = flag('--out', null);

const rawQueries = fs.readFileSync(queriesPath, 'utf8').trim();
const queries = rawQueries.startsWith('[')
  ? JSON.parse(rawQueries)
  : rawQueries.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

function callUnixSocket(sockPath, toolName, toolArgs, attempt = 1) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: toolArgs } });
    const req = http.request({
      socketPath: sockPath,
      path: '/rpc',
      method: 'POST',
      agent: false,
      timeout: 60000,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'connection': 'close'
      }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const text = parsed?.result?.content?.[0]?.text;
          resolve(text ? JSON.parse(text) : parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Socket timeout 60s')); });
    req.on('error', (err) => {
      if (attempt < 3) {
        setTimeout(() => callUnixSocket(sockPath, toolName, toolArgs, attempt + 1).then(resolve, reject), 500 * attempt);
      } else {
        reject(err);
      }
    });
    req.write(body);
    req.end();
  });
}

function isMatch(result, expected) {
  const key = String(result.key || '').toLowerCase();
  const id = String(result.id || '').toLowerCase();
  const src = String(result.source || '').toLowerCase();
  for (const exp of expected) {
    const e = String(exp).toLowerCase();
    if (key === e || id === e || id.includes(e) || key.includes(e) || src.includes(e)) return true;
  }
  return false;
}

function computeNdcg(results, expected, k) {
  if (!expected.length) return results.length === 0 ? 1 : 0;
  let dcg = 0;
  let matched = 0;
  for (let i = 0; i < Math.min(k, results.length); i++) {
    if (isMatch(results[i], expected)) {
      dcg += 1 / Math.log2(i + 2);
      matched++;
    }
  }
  const idealHits = Math.min(k, Math.max(1, matched));
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

let searchFn;
let cleanup = () => {};
let engineMeta = {};

if (mode === 'legacy-socket') {
  const sock = flag('--socket', '/run/sonar/mcp.sock');
  const st = await callUnixSocket(sock, 'memory_stats', {});
  engineMeta = { mode, socket: sock, backend: st.backend, model: st.model, vectors: st.vectors, sources: st.sources };
  searchFn = (q) => callUnixSocket(sock, 'memory_search_unified', { query: q.query, limit: 20, ...(q.project ? { project: q.project } : {}), ...(q.namespace ? { namespace: q.namespace } : {}) });
} else {
  const cfgPath = expandHome(flag('--config', '/etc/sonar/config.json'));
  const cfg = resolveConfigPaths(JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
  const modelId = flag('--model', cfg.embeddingModel);
  const gen = flag('--generation', null);
  const rerankK = Number(flag('--rerank-k', 0));
  const rerankTimeout = Number(flag('--rerank-timeout', 250));

  const canonical = new CanonicalStore(cfg.database, { stateRoot: cfg.index });
  const embedder = new OfflineEmbedder({ modelRoot: cfg.modelRoot, modelId, intraThreads: 2 });
  await embedder.init();

  let reranker = null;
  if (rerankK > 0) {
    reranker = new OfflineReranker({ modelRoot: cfg.modelRoot, modelId: cfg.rerankerModel, intraThreads: 4, timeoutMs: rerankTimeout });
    await reranker.init();
  }

  const engine = new SearchEngine({
    indexRoot: cfg.index,
    embedder,
    reranker,
    canonicalStore: canonical,
    rerankDefaultK: rerankK || 8,
    rerankAdaptiveK: rerankK || 8,
    rerankTimeoutMs: rerankTimeout
  });
  engine.loadGeneration(gen);
  engineMeta = { mode, generation: engine.current.generation, modelId, rerankK, rerankTimeout, status: engine.status() };

  searchFn = (q) => engine.search({
    query: q.query,
    limit: 20,
    rerank: rerankK > 0 ? 'auto' : 'off',
    rerank_k: rerankK || undefined,
    ...(q.project ? { project: q.project } : {}),
    ...(q.namespace ? { namespace: q.namespace } : {})
  });
  cleanup = () => { engine.close(); canonical.close(); };
}

// Warmup
await searchFn(queries[0]);

const latencies = [];
const vectorLatencies = [];
const ftsLatencies = [];
const embedLatencies = [];
const rerankLatencies = [];
const byCategory = {};
const details = [];
let sumNdcg5 = 0;
let sumNdcg10 = 0;
let sumRec10 = 0;
let sumRec20 = 0;
let sumMrr = 0;
let exactTotal = 0;
let exactHit1 = 0;
let positiveCount = 0;
let rerankAppliedCount = 0;

let doneQ = 0;
for (const q of queries) {
  const t0 = performance.now();
  const res = await searchFn(q);
  const ms = performance.now() - t0;
  doneQ++;
  if (doneQ % 15 === 0 || doneQ === queries.length) {
    process.stderr.write(`eval ${mode}: ${doneQ}/${queries.length} (last ${Math.round(ms)}ms)\n`);
  }
  latencies.push(ms);
  if (res.timings?.vectorMs !== undefined) vectorLatencies.push(res.timings.vectorMs);
  if (res.timings?.ftsMs !== undefined) ftsLatencies.push(res.timings.ftsMs);
  if (res.timings?.embedMs !== undefined) embedLatencies.push(res.timings.embedMs);
  if (res.rerank?.ms !== undefined) rerankLatencies.push(res.rerank.ms);
  if (res.rerank?.applied) rerankAppliedCount++;

  const results = res.results || [];
  const expected = q.expected || [];
  const cat = q.category || 'general';
  if (!byCategory[cat]) byCategory[cat] = { count: 0, hit1: 0, hit5: 0, hit10: 0, hit20: 0, ndcg5: 0, ndcg10: 0, latencies: [] };
  const bucket = byCategory[cat];
  bucket.count++;
  bucket.latencies.push(ms);

  if (expected.length > 0) {
    positiveCount++;
    const firstRank = results.findIndex((r) => isMatch(r, expected));
    const h1 = firstRank === 0 ? 1 : 0;
    const h5 = firstRank >= 0 && firstRank < 5 ? 1 : 0;
    const h10 = firstRank >= 0 && firstRank < 10 ? 1 : 0;
    const h20 = firstRank >= 0 && firstRank < 20 ? 1 : 0;
    const nd5 = computeNdcg(results, expected, 5);
    const nd10 = computeNdcg(results, expected, 10);
    const rr = firstRank >= 0 ? 1 / (firstRank + 1) : 0;

    sumNdcg5 += nd5; sumNdcg10 += nd10; sumRec10 += h10; sumRec20 += h20; sumMrr += rr;
    bucket.hit1 += h1; bucket.hit5 += h5; bucket.hit10 += h10; bucket.hit20 += h20;
    bucket.ndcg5 += nd5; bucket.ndcg10 += nd10;

    if (cat === 'exact-id') {
      exactTotal++;
      if (h1) exactHit1++;
    }
    details.push({ id: q.id, category: cat, query: q.query, firstRank, ms: Math.round(ms), fastPath: res.fastPath || null, top3: results.slice(0, 3).map((r) => r.key) });
  }
}

cleanup();

const categorySummary = {};
for (const [k, b] of Object.entries(byCategory)) {
  categorySummary[k] = {
    count: b.count,
    hit1: Number((b.hit1 / Math.max(1, b.count)).toFixed(3)),
    hit10: Number((b.hit10 / Math.max(1, b.count)).toFixed(3)),
    ndcg5: Number((b.ndcg5 / Math.max(1, b.count)).toFixed(4)),
    ndcg10: Number((b.ndcg10 / Math.max(1, b.count)).toFixed(4)),
    p95Ms: Math.round(percentile(b.latencies, 0.95))
  };
}

const report = {
  at: new Date().toISOString(),
  engineMeta,
  queryCount: queries.length,
  positiveCount,
  metrics: {
    nDCG5: Number((sumNdcg5 / Math.max(1, positiveCount)).toFixed(4)),
    nDCG10: Number((sumNdcg10 / Math.max(1, positiveCount)).toFixed(4)),
    Recall10: Number((sumRec10 / Math.max(1, positiveCount)).toFixed(4)),
    Recall20: Number((sumRec20 / Math.max(1, positiveCount)).toFixed(4)),
    MRR: Number((sumMrr / Math.max(1, positiveCount)).toFixed(4)),
    exactIdHit1: exactTotal ? Number((exactHit1 / exactTotal).toFixed(4)) : null,
    p50Ms: Math.round(percentile(latencies, 0.50)),
    p95Ms: Math.round(percentile(latencies, 0.95)),
    maxMs: Math.round(Math.max(...latencies)),
    ftsP95Ms: ftsLatencies.length ? Math.round(percentile(ftsLatencies, 0.95)) : 0,
    embedP95Ms: embedLatencies.length ? Math.round(percentile(embedLatencies, 0.95)) : 0,
    vectorScanP95Ms: vectorLatencies.length ? Math.round(percentile(vectorLatencies, 0.95)) : 0,
    rerankApplied: rerankAppliedCount,
    rerankP95Ms: rerankLatencies.length ? Math.round(percentile(rerankLatencies, 0.95)) : 0,
    rssMB: Math.round(process.memoryUsage().rss / (1024 * 1024))
  },
  byCategory: categorySummary,
  misses: details.filter((d) => d.firstRank < 0 || d.firstRank >= 10)
};

if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ engineMeta: report.engineMeta, queryCount: report.queryCount, metrics: report.metrics, byCategory: report.byCategory, missCount: report.misses.length }, null, 2));
