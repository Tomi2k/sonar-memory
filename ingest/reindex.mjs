#!/usr/bin/env node
// Einstiegspunkt für die getrennte Reindex-Unit (`sonar-reindex.service`) und manuelle Rebuilds.
import fs from 'node:fs';
import { OfflineEmbedder } from '../core/embedder.mjs';
import { expandHome, resolveConfigPaths } from '../core/paths.mjs';
import { buildIndexGeneration } from './builder.mjs';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
};

const cfgPath = expandHome(flag('--config', process.env.SONAR_CONFIG || '/etc/sonar/config.json'));
const cfg = resolveConfigPaths(JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
const modelId = flag('--model', cfg.embeddingModel || 'Xenova/multilingual-e5-small');
const maxPassages = flag('--max-passages') ? Number(flag('--max-passages')) : null;
const activate = !args.includes('--no-activate');
const force = args.includes('--force');
const threads = Number(flag('--threads', cfg.reindexThreads || 2));
const workers = Number(flag('--workers', 1));

const embedder = new OfflineEmbedder({
  modelRoot: cfg.modelRoot || '/var/lib/sonar/models',
  modelId,
  intraThreads: threads,
  interThreads: 1
});

const result = await buildIndexGeneration({
  indexRoot: cfg.index,
  database: cfg.database,
  sourceRoots: cfg.sources || [],
  policy: cfg.policyFile || cfg.policy || null,
  trustedRoots: cfg.trustedRoots || [],
  embedder,
  screenOptions: cfg.screenOptions || {},
  batchSize: Number(flag('--batch-size', 16)),
  workers,
  workerThreads: threads,
  maxPassages,
  minMemAvailableGiB: Number(flag('--min-mem', cfg.minMemAvailableGiB ?? 1.5)),
  activate,
  force,
  onProgress: (p) => {
    const rssMB = Math.round(process.memoryUsage().rss / (1024 * 1024));
    process.stderr.write(JSON.stringify({ stage: 'embed', rssMB, ...p }) + '\n');
  }
});

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
