import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normalizeText,
  stemWord,
  extractExactKeys,
  detectExactQueryKey,
  buildSafeFtsQuery
} from '../../core/normalize.mjs';
import { chunkText } from '../../core/chunker.mjs';
import { createPolicy, shouldSkipDirectory, classifyMarkdownSource, classifyKind, classifyTrust } from '../../ingest/policy.mjs';
import { collectAndClassifySources } from '../../ingest/builder.mjs';
import { screenSources } from '../../core/secret-screen.mjs';
import { resolveConfigPaths } from '../../core/paths.mjs';
import { quantizeInt8, Int8VectorStore } from '../../core/search/vector-scan.mjs';
import { CanonicalStore } from '../../core/store/canonical.mjs';

const __unitDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__unitDir, '../..');

test('normalizeText folds German umlauts consistently (Prüfung == Pruefung, Straße == Strasse)', () => {
  assert.equal(normalizeText('Prüfung'), normalizeText('Pruefung'));
  assert.equal(normalizeText('Straße'), normalizeText('Strasse'));
  assert.equal(normalizeText('Größe'), normalizeText('Groesse'));
  assert.equal(normalizeText('Änderung'), normalizeText('Aenderung'));
  assert.equal(stemWord('sicherungen'), stemWord('sicherung'));
});

test('extractExactKeys & detectExactQueryKey handle ticket IDs, entry IDs, and filenames', () => {
  const keys = extractExactKeys('Fix in server.mjs for BUG-1042 and FEAT-2099 (entry_1700000000000_abcdef1234567890)');
  assert.ok(keys.includes('bug-1042'));
  assert.ok(keys.includes('feat-2099'));
  assert.ok(keys.includes('server.mjs'));
  assert.ok(keys.includes('entry_1700000000000_abcdef1234567890'));

  assert.equal(detectExactQueryKey('BUG-1042'), 'bug-1042');
  assert.equal(detectExactQueryKey('backup-restore-runbook-20260115'), 'backup-restore-runbook-20260115');
  assert.equal(detectExactQueryKey('Wie funktioniert das Backup?'), null);
});

test('buildSafeFtsQuery neutralizes raw FTS5 syntax characters', () => {
  const q = buildSafeFtsQuery('sonar-memory: "socket" (restart) -broken OR NOT *');
  assert.ok(q && !q.includes('*'));
  assert.ok(q.includes('exact:"sonar"'));
  assert.ok(q.includes('exact:"socket"'));
});

test('chunkText prepends Context-Header (Project › Key › H1 › H2) and respects headings', () => {
  const md = '# Haupttitel\n\nErster Absatz.\n\n## Abschnitt Zwei\n\n' + 'Wort '.repeat(350);
  const chunks = chunkText(md, { project: 'webapp', key: 'STATE' }, { maxChars: 600, overlapChars: 80 });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].header.includes('webapp › STATE › Haupttitel'));
  assert.ok(chunks.at(-1).header.includes('Abschnitt Zwei'));
  assert.ok(chunks[0].embedText.startsWith('[webapp › STATE'));

  // ReDoS safety: long heading with trailing spaces must scan in linear time (<200 ms) (F-05)
  const evilLine = '# ' + 'x'.repeat(20000) + ' '.repeat(20000) + '!\n\nBody text.';
  const t0 = performance.now();
  const evilChunks = chunkText(evilLine, { key: 'redos-check' });
  assert.ok(performance.now() - t0 < 200, 'scanHeadings must run in linear time without backtracking');
  assert.ok(evilChunks.length >= 1);
});

test('CLI parses boolean rule confirmation flags and builder skips symlink Markdown files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-cli-sym-'));
  try {
    // 1. CLI boolean flag coercion for --confirm-rule-write / --confirm-rule-supersede (F-05)
    const stubBin = path.join(tmp, 'echo-mcp.sh');
    fs.writeFileSync(stubBin, '#!/usr/bin/env bash\nprintf "%s\\n%s\\n" "$1" "$2"\n', { mode: 0o755 });
    const cliPath = path.join(REPO_ROOT, 'cli/sonar.mjs');
    const rOk = spawnSync(
      process.execPath,
      [cliPath, 'store', '--key', 'r1', '--value', 'v1', '--kind', 'rule', '--confirm-rule-write', 'true', '--confirm-rule-supersede', 'false'],
      { env: { ...process.env, SONAR_MCP_BIN: stubBin }, encoding: 'utf8' }
    );
    assert.equal(rOk.status, 0);
    const [, jsonLine] = rOk.stdout.trim().split('\n');
    const parsedArgs = JSON.parse(jsonLine);
    assert.strictEqual(parsedArgs.confirm_rule_write, true);
    assert.strictEqual(parsedArgs.confirm_rule_supersede, false);

    // 2. Symlink .md inside source root must not be read (F-06)
    const secretFile = path.join(tmp, 'outside.md');
    fs.writeFileSync(secretFile, '# Outside Secret\n\nShould never be indexed via symlink.\n');
    const srcRoot = path.join(tmp, 'notes');
    fs.mkdirSync(srcRoot);
    fs.writeFileSync(path.join(srcRoot, 'real.md'), '# Real Note\n\nSafe regular markdown.\n');
    fs.symlinkSync(secretFile, path.join(srcRoot, 'link.md'));
    const dbPath = path.join(tmp, 'memory.db');
    const collected = collectAndClassifySources({ database: dbPath, sourceRoots: [srcRoot] });
    assert.equal(collected.sources.length, 1);
    assert.equal(collected.sources[0].key, 'real');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('policy classifies curated vs archive vs excluded and detects .expires & git worktrees', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-pol-'));
  try {
    const expDir = path.join(tmp, 'temp-loop');
    fs.mkdirSync(expDir);
    fs.writeFileSync(path.join(expDir, '.expires'), '2026-12-01\ntest\n');
    assert.equal(shouldSkipDirectory(expDir, 'temp-loop'), 'expires-folder');

    const wtDir = path.join(tmp, 'wt-branch');
    fs.mkdirSync(wtDir);
    fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: /somewhere/.git/worktrees/wt-branch\n');
    assert.equal(shouldSkipDirectory(wtDir, 'wt-branch'), 'git-worktree');

    const trustedDir = path.join(tmp, 'trusted-policies');
    fs.mkdirSync(trustedDir);
    const customPol = createPolicy({
      trustedRoots: [trustedDir],
      extraArchivePatterns: ['(^|/)exports(/|$)'],
      extraHardExcludePatterns: ['_raw_dump_.*\\.json\\.md$']
    });
    assert.equal(classifyMarkdownSource('policies/rules/guide.md', 'guide.md', 2000, customPol).tier, 'curated');
    assert.equal(classifyMarkdownSource('workspace/exports/report.md', 'report.md', 5000, customPol).tier, 'archive');
    assert.equal(classifyMarkdownSource('data/_raw_dump_2026.json.md', '_raw_dump_2026.json.md', 50000, customPol).tier, 'exclude');
    assert.equal(classifyMarkdownSource('docs/THIRD-PARTY-LICENSES.txt.md', 'THIRD-PARTY-LICENSES.txt.md', 50000, customPol).tier, 'exclude');
    // Trusted root receives non-expiring `rule` + `own-rule`
    assert.equal(classifyKind({ relativePath: 'rules/ops.md', fullPath: path.join(trustedDir, 'rules/ops.md'), namespace: 'markdown' }, customPol), 'rule');
    assert.equal(classifyTrust({ relativePath: 'rules/ops.md', fullPath: path.join(trustedDir, 'rules/ops.md'), namespace: 'markdown' }, customPol), 'own-rule');
    // Untrusted third-party repo CLAUDE.md MUST NOT escalate to `own-rule` or non-expiring `rule`
    assert.equal(classifyKind({ relativePath: 'projects/third-party/CLAUDE.md', fullPath: path.join(tmp, 'projects/third-party/CLAUDE.md'), namespace: 'markdown' }, customPol), 'doc');
    assert.equal(classifyTrust({ relativePath: 'projects/third-party/CLAUDE.md', fullPath: path.join(tmp, 'projects/third-party/CLAUDE.md'), namespace: 'markdown' }, customPol), 'workspace-doc');
    // Prefix-collision path (trusted-policies-evil) must NOT match trusted-policies
    assert.equal(classifyTrust({ relativePath: 'CLAUDE.md', fullPath: path.join(tmp, 'trusted-policies-evil/CLAUDE.md'), namespace: 'markdown' }, customPol), 'workspace-doc');
    assert.equal(classifyKind({ relativePath: 'projects/acme/STATE.md', namespace: 'markdown' }, customPol), 'state');

    // Secret screening fails closed when explicit binPath OR cfgPath is missing, OR when cfgPath is set without gitleaks in PATH (F-03)
    assert.throws(
      () => screenSources([{ id: 'x', key: 'k', text: 'hello' }], tmp, { binPath: path.join(tmp, 'missing-gitleaks') }),
      /Gitleaks not available/
    );
    assert.throws(
      () => screenSources([{ id: 'x', key: 'k', text: 'hello' }], tmp, { cfgPath: path.join(tmp, 'missing-gitleaks.toml'), requireGitleaks: false }),
      /Gitleaks config not found/
    );
    const dummyCfg = path.join(tmp, 'gitleaks.toml');
    fs.writeFileSync(dummyCfg, 'title = "test"\n');
    const prevPath = process.env.PATH;
    process.env.PATH = '';
    try {
      assert.throws(
        () => screenSources([{ id: 'x', key: 'k', text: 'hello' }], tmp, { cfgPath: dummyCfg }),
        /Gitleaks not available/
      );
    } finally {
      process.env.PATH = prevPath;
    }
    const fakeHf = ['hf_', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('');
    const fallbackRes = screenSources([{ id: 'x', key: 'k', text: fakeHf }], tmp, { requireGitleaks: false, silentFallback: true });
    assert.equal(fallbackRes.excluded.length, 1);

    // Gitleaks exit 1 (fatal CLI/config error, e.g. Gitleaks < 8.19 lacking `dir`) must fail closed and never cache clean (F1)
    const fakeBrokenGl = path.join(tmp, 'fake-gitleaks-err.sh');
    fs.writeFileSync(fakeBrokenGl, '#!/usr/bin/env bash\nif [ "$1" = "version" ]; then echo "8.18.0"; exit 0; fi\necho "unknown command dir" >&2\nexit 1\n', { mode: 0o755 });
    const glStateDir = path.join(tmp, 'gl-err-state');
    assert.throws(
      () => screenSources([{ id: 's1', key: 'k', text: 'clean text' }], glStateDir, { binPath: fakeBrokenGl }),
      /Secret scan failed \(exit 1/
    );
    assert.equal(fs.existsSync(path.join(glStateDir, 'secret-screen-state-v2.json')), false);

    // Gitleaks exit 99 with report.json blocks the offending file cleanly
    const fakeLeakGl = path.join(tmp, 'fake-gitleaks-leak.sh');
    fs.writeFileSync(
      fakeLeakGl,
      '#!/usr/bin/env bash\nif [ "$1" = "version" ]; then echo "8.24.0"; exit 0; fi\nSCAN_DIR="$2"\nREPORT=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "--report-path" ]; then REPORT="$2"; shift; fi; shift; done\nFIRST_FILE=$(ls "$SCAN_DIR"/*.txt | head -n 1)\nprintf \'[{"File":"%s"}]\' "$FIRST_FILE" > "$REPORT"\nexit 99\n',
      { mode: 0o755 }
    );
    const glLeakDir = path.join(tmp, 'gl-leak-state');
    const glLeakRes = screenSources([{ id: 'leak-1', key: 'k', text: 'secret value' }], glLeakDir, { binPath: fakeLeakGl });
    assert.equal(glLeakRes.safe.length, 0);
    assert.equal(glLeakRes.excluded.length, 1);

    // Config path tilde expansion
    const expanded = resolveConfigPaths({ database: '~/sonar/memory.db', sources: ['~/notes'] });
    assert.ok(path.isAbsolute(expanded.database) && !expanded.database.startsWith('~'));
    assert.ok(path.isAbsolute(expanded.sources[0]) && !expanded.sources[0].startsWith('~'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Int8VectorStore preserves >0.99 cosine fidelity and exact filter recall', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-vec-'));
  try {
    const dim = 384;
    const n = 200;
    const vecs = [];
    const i8Parts = [];
    const scaleParts = [];
    const f32Parts = [];
    for (let i = 0; i < n; i++) {
      const v = new Float32Array(dim);
      let norm = 0;
      for (let j = 0; j < dim; j++) {
        v[j] = Math.sin((i + 1) * (j + 1) * 0.17);
        norm += v[j] * v[j];
      }
      norm = Math.sqrt(norm);
      for (let j = 0; j < dim; j++) v[j] /= norm;
      vecs.push(v);
      const { q, scale } = quantizeInt8(v);
      i8Parts.push(Buffer.from(q.buffer, q.byteOffset, q.byteLength));
      const sb = Buffer.allocUnsafe(4); sb.writeFloatLE(scale, 0); scaleParts.push(sb);
      f32Parts.push(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    }
    const vp = path.join(tmp, 'vectors.i8');
    const sp = path.join(tmp, 'scales.f32');
    const fp = path.join(tmp, 'vectors.f32');
    fs.writeFileSync(vp, Buffer.concat(i8Parts));
    fs.writeFileSync(sp, Buffer.concat(scaleParts));
    fs.writeFileSync(fp, Buffer.concat(f32Parts));

    const store = new Int8VectorStore({ vectorsPath: vp, scalesPath: sp, fp32Path: fp, count: n, dim });
    const hits = store.search(vecs[42], { topK: 5 });
    assert.equal(hits[0].slot, 42);
    assert.ok(hits[0].score > 0.999);

    const filtered = store.search(vecs[42], { topK: 5, allowedList: [10, 42, 99] });
    assert.equal(filtered.length, 3);
    assert.equal(filtered[0].slot, 42);
    store.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CanonicalStore enforces cycle detection, 3-hop supersedes chains, conflicts, and hard purge', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-db-'));
  const dbPath = path.join(tmp, 'memory.db');
  const store = new CanonicalStore(dbPath, { stateRoot: tmp, screenOptions: { requireGitleaks: false } });
  try {
    const a = store.store({ namespace: 'patterns', key: 'rule-v1', value: 'Old local write rule: clients write directly to SQLite.' });
    const b = store.store({ namespace: 'patterns', key: 'rule-v2', value: 'Intermediate rule: single background service writes SQLite.' });
    const c = store.store({ namespace: 'patterns', key: 'rule-v3', value: 'Active rule: central Sonar daemon is the single writer.' });

    store.supersede({ old_ref: a.ref, new_ref: b.ref, reason: 'Single-writer migration' });
    store.supersede({ old_ref: b.ref, new_ref: c.ref, reason: 'Sonar cutover' });

    // Zyklus muss scheitern
    assert.throws(() => store.supersede({ old_ref: c.ref, new_ref: a.ref, reason: 'bad cycle' }), /Zyklische Ersetzung/);

    // 2-Hop-Auflösung zeigt direkt auf c
    const succ = store.resolveActiveSuccessor(a.ref);
    assert.equal(succ.target, c.ref);
    assert.equal(succ.hops, 2);

    // Widerspruch markieren & auflösen
    const d = store.store({ namespace: 'patterns', key: 'conflict-a', value: 'Limit 500 MB' });
    const e = store.store({ namespace: 'patterns', key: 'conflict-b', value: 'Limit 2 GB' });
    const cf = store.flagConflict({ ref_a: d.ref, ref_b: e.ref, reason: 'Unterschiedliche Limits' });
    assert.equal(store.relationStats().openConflicts, 1);

    store.resolveConflict({ relation_id: cf.relation_id, winner_ref: e.ref, reason: '2 GB gemessen' });
    assert.equal(store.relationStats().openConflicts, 0);
    assert.equal(store.resolveActiveSuccessor(d.ref).target, e.ref);

    // Re-upserting a previously superseded entry dismisses the old incoming `supersedes` edge (F-05)
    store.store({ namespace: 'patterns', key: 'rule-v1', value: 'Reactivated rule-v1 content', upsert: true });
    assert.equal(store.resolveActiveSuccessor(a.ref), null);
    assert.equal(store.retrieve('patterns', 'rule-v1').superseded_by, null);

    // Hartes Purge entfernt Zeile + Relationen dauerhaft
    const p = store.purge('patterns', 'conflict-a');
    assert.equal(p.purged, true);
    assert.equal(store.retrieve('patterns', 'conflict-a', { include_history: true }), null);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
