// Punkt 2.1: Offline-ONNX Cross-Encoder-Reranker (cross-encoder/mmarco-mMiniLMv2-L12-H384-v1, INT8).
// Mit Concurrency-Cap (max 1 aktiver Batch), hartem Zeitlimit (250 ms Default) -> Fallback auf RRF,
// und LRU-Cache auf (queryHash, chunkHash).
import crypto from 'node:crypto';
import { loadManifest, verifyModelFiles } from './embedder.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export class OfflineReranker {
  constructor(options = {}) {
    this.modelRoot = options.modelRoot || '/var/lib/sonar/models';
    this.manifest = loadManifest(options.manifestPath);
    this.modelId = options.modelId || this.manifest.defaultRerankerModel;
    this.intraThreads = options.intraThreads ?? 4;
    this.interThreads = options.interThreads ?? 1;
    this.timeoutMs = options.timeoutMs ?? 250;
    this.maxQueryChars = options.maxQueryChars ?? 240; // keeps candidate docs well within max_length=160
    this.maxCharsPerPassage = options.maxCharsPerPassage ?? 560; // ~140-160 Token (schnell auf CPU, deckt Kontext-Header + Kernantwort)
    this.maxTokens = options.maxTokens ?? 160;
    this.cacheLimit = options.cacheLimit ?? 2000;
    this.cache = new Map();
    this.busy = false;
    this.tokenizer = null;
    this.model = null;
    this.spec = null;
    this.modelHash = null;
  }

  async init() {
    if (this.model && this.tokenizer) return this;
    const { spec, modelHash } = verifyModelFiles(this.modelRoot, this.modelId, this.manifest);
    this.spec = spec;
    this.modelHash = modelHash;

    const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;
    env.localModelPath = this.modelRoot.endsWith('/') ? this.modelRoot : this.modelRoot + '/';

    this.tokenizer = await AutoTokenizer.from_pretrained(this.modelId, { local_files_only: true });
    this.model = await AutoModelForSequenceClassification.from_pretrained(this.modelId, {
      dtype: spec.dtype || 'q8',
      local_files_only: true,
      session_options: {
        intra_op_num_threads: this.intraThreads,
        inter_op_num_threads: this.interThreads,
        enableCpuMemArena: false,
        enableMemPattern: false
      }
    });
    return this;
  }

  _cacheGet(key) {
    if (!this.cache.has(key)) return undefined;
    const v = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, v);
    return v;
  }

  _cacheSet(key, value) {
    if (this.cache.size >= this.cacheLimit) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }

  /**
   * Bewertet bis zu `topK` Kandidaten neu.
   * Bricht sauber ab (Fallback auf bestehende RRF-Reihenfolge), wenn Worker belegt ist oder Timeout greift.
   */
  async rerank(query, candidates, options = {}) {
    const started = performance.now();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const k = Math.min(candidates.length, options.topK ?? 8);
    if (k <= 1) {
      return { items: candidates, applied: false, reason: 'too-few-candidates', ms: 0 };
    }
    if (this.busy && !options.waitIfBusy) {
      return { items: candidates, applied: false, reason: 'reranker-busy-fallback-rrf', ms: 0 };
    }

    if (!this.model) await this.init();
    const head = candidates.slice(0, k);
    const tail = candidates.slice(k);

    const boundedQuery = String(query || '').slice(0, this.maxQueryChars);
    const qHash = sha(boundedQuery);
    const scores = new Array(k).fill(null);
    const missingIdx = [];
    for (let i = 0; i < k; i++) {
      const pKey = `${qHash}:${head[i].chunkHash || sha(head[i].rerankText || head[i].text || '')}`;
      const hit = this._cacheGet(pKey);
      if (hit !== undefined) {
        scores[i] = hit;
      } else {
        missingIdx.push({ i, pKey, text: String(head[i].rerankText || head[i].text || '').slice(0, this.maxCharsPerPassage) });
      }
    }

    if (missingIdx.length) {
      this.busy = true;
      try {
        // Verarbeite in kleinen Teilbatches (4 Paare), damit wir das Zeitlimit zwischen Batches strikt einhalten können.
        const batchSize = 4;
        let timedOut = false;
        for (let offset = 0; offset < missingIdx.length; offset += batchSize) {
          if (!options.noTimeout && (performance.now() - started) >= timeoutMs) {
            timedOut = true;
            break;
          }
          const slice = missingIdx.slice(offset, offset + batchSize);
          const queries = new Array(slice.length).fill(boundedQuery);
          const docs = slice.map((x) => x.text);
          const inputs = this.tokenizer(queries, {
            text_pair: docs,
            padding: true,
            truncation: true,
            max_length: this.maxTokens
          });
          const { logits } = await this.model(inputs);
          const raw = logits.data;
          // Einzellogit je Paar (kein Softmax auf 1 Label! Sigmoid für [0,1]-Anzeige, roher Logit für Sortierung)
          for (let j = 0; j < slice.length; j++) {
            const logit = Number(raw[j]);
            const prob = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, logit))));
            const entry = { logit, prob };
            scores[slice[j].i] = entry;
            this._cacheSet(slice[j].pKey, entry);
          }
        }
        if (timedOut) {
          return {
            items: candidates,
            applied: false,
            reason: `timeout-exceeded-${timeoutMs}ms-fallback-rrf`,
            ms: Math.round(performance.now() - started)
          };
        }
      } finally {
        this.busy = false;
      }
    }

    const rerankedHead = head
      .map((item, i) => ({
        ...item,
        rerankLogit: scores[i].logit,
        rerankScore: Number(scores[i].prob.toFixed(4))
      }))
      .sort((a, b) => b.rerankLogit - a.rerankLogit);

    return {
      items: [...rerankedHead, ...tail],
      applied: true,
      k,
      cacheHits: k - missingIdx.length,
      ms: Math.round(performance.now() - started)
    };
  }

  info() {
    return {
      modelId: this.modelId,
      modelHash: this.modelHash,
      dtype: this.spec?.dtype || 'q8',
      license: this.spec?.license || 'Apache-2.0',
      timeoutMs: this.timeoutMs
    };
  }
}
