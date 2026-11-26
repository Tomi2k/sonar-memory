#!/usr/bin/env node
// Downloads commit-pinned offline ONNX models listed in models/manifest.json and verifies SHA-256 checksums.
// Runs ONLY during initial setup; runtime stays 100% offline (allowRemoteModels = false).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome } from '../core/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(__dirname, '../models/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const modelRoot = path.resolve(expandHome(flag('--dir', path.join(process.env.HOME || '.', '.local/share/sonar/models'))));
const selected = [manifest.defaultEmbeddingModel, manifest.defaultRerankerModel];

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

for (const modelId of selected) {
  const spec = manifest.models[modelId];
  if (!spec) throw new Error(`Unknown model in manifest: ${modelId}`);
  if (!/^[0-9a-f]{40}$/.test(spec.revision || '')) {
    throw new Error(`Refusing unpinned download: missing 40-char commit revision for ${modelId}`);
  }
  console.log(`\n==> Model: ${modelId} (${spec.license}, rev ${spec.revision.slice(0, 12)})`);
  for (const [rel, meta] of Object.entries(spec.files || {})) {
    const dest = path.join(modelRoot, modelId, rel);
    const expectedSha = meta?.sha256;
    if (!expectedSha) {
      throw new Error(`Refusing unverified download: missing sha256 in manifest for ${modelId}/${rel}`);
    }
    const remoteRel = meta.remotePath || rel;
    const url = `https://huggingface.co/${modelId}/resolve/${spec.revision}/${remoteRel}`;
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    if (fs.existsSync(dest) && sha256File(dest) === expectedSha) {
      console.log(`  [ok] ${rel} (cached & verified)`);
      continue;
    }
    console.log(`  [dl] ${rel}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `${dest}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, buf, { mode: 0o600, flag: 'wx' });
    const actualSha = sha256File(tmp);
    if (actualSha !== expectedSha) {
      fs.unlinkSync(tmp);
      throw new Error(`SHA-256 mismatch for ${rel}: expected ${expectedSha}, got ${actualSha}`);
    }
    fs.renameSync(tmp, dest);
    console.log(`  [verified] ${rel} (${buf.byteLength} bytes, sha256=${actualSha.slice(0, 12)}...)`);
  }
}
console.log('\nAll offline ONNX models verified and ready in:', modelRoot);
