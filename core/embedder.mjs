// Offline-ONNX-Embedder mit SHA-256-Manifestprüfung, Präfix-Vertrag (query:/passage:) und Thread-Begrenzung.
// PrivateNetwork=yes kompatibel: env.allowRemoteModels bleibt strikt false.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = path.resolve(__dirname, '../models/manifest.json');

const sha256File = (filePath) => {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

export function loadManifest(manifestPath = DEFAULT_MANIFEST) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

export function verifyModelFiles(modelRoot, modelId, manifest) {
  const spec = manifest.models[modelId];
  if (!spec) throw new Error(`Unbekanntes Modell im Manifest: ${modelId}`);
  const allowedLicenses = new Set(['MIT', 'Apache-2.0']);
  if (!allowedLicenses.has(spec.license)) {
    throw new Error(`Unzulässige Modell-Lizenz für ${modelId}: ${spec.license}`);
  }
  const dir = path.join(modelRoot, modelId);
  const hashes = {};
  for (const [rel, expected] of Object.entries(spec.files || {})) {
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) {
      throw new Error(`Modelldatei fehlt offline: ${full}`);
    }
    const actual = sha256File(full);
    if (!expected?.sha256) {
      throw new Error(`SHA-256 fehlt im Manifest für ${modelId}/${rel} (fail-closed).`);
    }
    if (actual !== expected.sha256) {
      throw new Error(`SHA-256-Fehler bei ${full}: erwartet ${expected.sha256}, erhalten ${actual}`);
    }
    hashes[rel] = actual;
  }
  const primaryHash = Object.values(hashes)[0] || '';
  return { spec, modelHash: primaryHash, fileHashes: hashes };
}

export class OfflineEmbedder {
  constructor(options = {}) {
    this.modelRoot = options.modelRoot || '/var/lib/sonar/models';
    this.manifest = loadManifest(options.manifestPath || DEFAULT_MANIFEST);
    this.modelId = options.modelId || this.manifest.defaultEmbeddingModel;
    this.intraThreads = options.intraThreads ?? 2;
    this.interThreads = options.interThreads ?? 1;
    this.pipe = null;
    this.spec = null;
    this.modelHash = null;
  }

  async init() {
    if (this.pipe) return this;
    const { spec, modelHash } = verifyModelFiles(this.modelRoot, this.modelId, this.manifest);
    this.spec = spec;
    this.modelHash = modelHash;

    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;
    env.localModelPath = this.modelRoot.endsWith('/') ? this.modelRoot : this.modelRoot + '/';

    this.pipe = await pipeline('feature-extraction', this.modelId, {
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

  formatQuery(text) {
    const prefix = this.spec?.queryPrefix || '';
    return prefix ? prefix + text : text;
  }

  formatPassage(text) {
    const prefix = this.spec?.passagePrefix || '';
    return prefix ? prefix + text : text;
  }

  async embedQuery(text) {
    if (!this.pipe) await this.init();
    const out = await this.pipe(this.formatQuery(String(text || '')), {
      pooling: this.spec.pooling || 'mean',
      normalize: this.spec.normalize !== false,
      truncation: true,
      max_length: this.spec.maxTokens || 256
    });
    const vec = new Float32Array(out.data);
    if (vec.length !== this.spec.dimensions) {
      throw new Error(`Ungültige Embedding-Dimension: ${vec.length} statt ${this.spec.dimensions}`);
    }
    return vec;
  }

  async embedPassages(texts) {
    if (!this.pipe) await this.init();
    if (!texts.length) return [];
    const formatted = texts.map((t) => this.formatPassage(String(t || '')));
    const out = await this.pipe(formatted, {
      pooling: this.spec.pooling || 'mean',
      normalize: this.spec.normalize !== false,
      truncation: true,
      max_length: this.spec.maxTokens || 256
    });
    const dim = this.spec.dimensions;
    if (out.data.length !== dim * texts.length) {
      throw new Error(`Batch-Embedding-Dimension fehlerhaft: ${out.data.length} vs ${dim * texts.length}`);
    }
    const result = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const slice = new Float32Array(dim);
      slice.set(out.data.subarray(i * dim, (i + 1) * dim));
      result[i] = slice;
    }
    return result;
  }

  info() {
    return {
      modelId: this.modelId,
      modelHash: this.modelHash,
      dimensions: this.spec?.dimensions || 384,
      dtype: this.spec?.dtype || 'q8',
      license: this.spec?.license || 'unknown',
      queryPrefix: this.spec?.queryPrefix || '',
      passagePrefix: this.spec?.passagePrefix || ''
    };
  }
}
