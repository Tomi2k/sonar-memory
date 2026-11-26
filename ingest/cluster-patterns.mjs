#!/usr/bin/env node
// P4 Altbestand-Clustering: findet Duplikat-Kandidaten (Kosinus > 0,92) in memory_entries (nur Bericht, keine automatische Löschung!).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expandHome } from '../core/paths.mjs';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const indexRoot = expandHome(flag('--index', '/var/lib/sonar/index'));
const threshold = Number(flag('--threshold', 0.92));
const rawOut = flag('--out', null);
const outPath = rawOut ? expandHome(rawOut) : null;

const gen = fs.readFileSync(path.join(indexRoot, 'CURRENT'), 'utf8').trim();
if (!/^generation-[a-zA-Z0-9._-]+$/.test(gen)) {
  throw new Error(`Invalid generation name in CURRENT: ${gen}`);
}
const resolvedRoot = path.resolve(indexRoot);
const dir = path.resolve(resolvedRoot, gen);
if (!dir.startsWith(resolvedRoot + path.sep)) {
  throw new Error(`Path traversal refused: ${dir}`);
}
const db = new Database(path.join(dir, 'index.db'), { readonly: true });

const rows = db.prepare(`
  SELECT s.id, s.key, s.namespace, s.updated, MIN(c.vec_slot) AS slot
  FROM sources s
  JOIN chunks c ON c.source_id = s.id
  WHERE s.id LIKE 'memory_entries:%' AND s.namespace = 'patterns' AND c.vec_slot IS NOT NULL
  GROUP BY s.id
`).all();

const vecBuf = fs.readFileSync(path.join(dir, 'vectors.i8'));
const scaleBuf = fs.readFileSync(path.join(dir, 'scales.f32'));
const dim = 384;
const int8 = new Int8Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.byteLength);
const scales = new Float32Array(scaleBuf.buffer, scaleBuf.byteOffset, scaleBuf.byteLength / 4);

const pairs = [];
for (let i = 0; i < rows.length; i++) {
  const si = rows[i].slot;
  const bi = si * dim;
  const sci = scales[si];
  for (let j = i + 1; j < rows.length; j++) {
    const sj = rows[j].slot;
    const bj = sj * dim;
    let dot = 0;
    for (let k = 0; k < dim; k++) dot += int8[bi + k] * int8[bj + k];
    const sim = dot * sci * scales[sj];
    if (sim >= threshold) {
      pairs.push({
        similarity: Number(sim.toFixed(4)),
        older: rows[i].updated <= rows[j].updated ? rows[i].id : rows[j].id,
        olderKey: rows[i].updated <= rows[j].updated ? rows[i].key : rows[j].key,
        newer: rows[i].updated <= rows[j].updated ? rows[j].id : rows[i].id,
        newerKey: rows[i].updated <= rows[j].updated ? rows[j].key : rows[i].key
      });
    }
  }
}

pairs.sort((a, b) => b.similarity - a.similarity);
const report = {
  at: new Date().toISOString(),
  generation: gen,
  patternsScanned: rows.length,
  threshold,
  candidatePairs: pairs.length,
  top50: pairs.slice(0, 50)
};
db.close();
if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ patternsScanned: report.patternsScanned, threshold, candidatePairs: report.candidatePairs, sampleTop10: pairs.slice(0, 10) }, null, 2));
