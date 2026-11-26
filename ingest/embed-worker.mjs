// Leichtgewichtiger Worker-Thread für paralleles Offline-ONNX-Embedding beim Erstaufbau (`--workers N`).
import { parentPort, workerData } from 'node:worker_threads';
import { OfflineEmbedder } from '../core/embedder.mjs';

const embedder = new OfflineEmbedder({
  modelRoot: workerData.modelRoot,
  modelId: workerData.modelId,
  intraThreads: workerData.intraThreads || 2,
  interThreads: 1
});

await embedder.init();
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', async (msg) => {
  if (msg.type === 'stop') {
    process.exit(0);
  }
  if (msg.type === 'embed') {
    try {
      const vecs = await embedder.embedPassages(msg.texts);
      const buffers = vecs.map((v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength));
      parentPort.postMessage({ type: 'result', jobId: msg.jobId, buffers });
    } catch (err) {
      parentPort.postMessage({ type: 'error', jobId: msg.jobId, error: err?.message || String(err) });
    }
  }
});
