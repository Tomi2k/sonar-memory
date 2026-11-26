// Such- & ONNX-Worker-Thread: hält den Haupt-Event-Loop des MCP-Servers vollständig frei.
// Führt FTS5, INT8-Flat-Scan, Embedding (E5/MiniLM) und Cross-Encoder-Reranking isoliert aus.
import { parentPort, workerData } from 'node:worker_threads';
import { CanonicalStore } from '../core/store/canonical.mjs';
import { OfflineEmbedder } from '../core/embedder.mjs';
import { OfflineReranker } from '../core/reranker.mjs';
import { SearchEngine } from '../core/search/engine.mjs';

const cfg = workerData;
let engine = null;
let embedder = null;
let reranker = null;
let canonical = null;

async function initWorker() {
  canonical = new CanonicalStore(cfg.database, {
    stateRoot: cfg.index,
    screenOptions: cfg.screenOptions || {}
  });
  embedder = new OfflineEmbedder({
    modelRoot: cfg.modelRoot,
    modelId: cfg.embeddingModel,
    intraThreads: cfg.searchThreads ?? 2,
    interThreads: 1
  });
  await embedder.init();

  if (cfg.rerankerEnabled !== false && cfg.rerankerModel) {
    reranker = new OfflineReranker({
      modelRoot: cfg.modelRoot,
      modelId: cfg.rerankerModel,
      intraThreads: cfg.rerankThreads ?? 4,
      interThreads: 1,
      timeoutMs: cfg.rerankTimeoutMs ?? 250
    });
    if (cfg.preloadReranker) {
      await reranker.init();
    }
  }

  engine = new SearchEngine({
    indexRoot: cfg.index,
    embedder,
    reranker,
    canonicalStore: canonical,
    rerankDefaultK: cfg.rerankDefaultK ?? 8,
    rerankAdaptiveK: cfg.rerankAdaptiveK ?? 8,
    rerankDeepK: cfg.rerankDeepK ?? 20,
    rerankTimeoutMs: cfg.rerankTimeoutMs ?? 250
  });

  try {
    engine.loadGeneration();
  } catch (err) {
    engine.lastError = err.message;
  }
}

await initWorker();
parentPort.postMessage({ type: 'ready', status: engine.status() });

parentPort.on('message', async (msg) => {
  const { id, action, payload } = msg;
  try {
    let result;
    if (action === 'search') {
      result = await engine.search(payload || {});
    } else if (action === 'embed_and_conflicts') {
      const vec = await embedder.embedPassages([payload.text]);
      const conflicts = engine.current
        ? await engine.findSemanticConflicts(vec[0], payload.namespace, payload.excludeRef, payload.minSim ?? 0.85)
        : [];
      result = { embedding: Array.from(vec[0]), model: embedder.modelId, conflicts };
    } else if (action === 'source') {
      result = engine.source(payload.id);
    } else if (action === 'sources') {
      result = engine.listSources(payload || {});
    } else if (action === 'status') {
      result = engine.status();
    } else if (action === 'reload') {
      result = engine.loadGeneration(payload?.generation || null);
    } else {
      throw new Error(`Unknown worker action: ${action}`);
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});
