// Gitleaks Secret-Screening mit Versionierung von Regeldatei UND Scanner-Binary im Cache-Key.
// Resolves gitleaks via SONAR_GITLEAKS_BIN or PATH, supports optional gitleaks.toml,
// uses mkdtempSync + O_EXCL temp writes, and warns loudly when falling back to regex mode.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let cachedSignature = null;
let fallbackWarned = false;

function resolveGitleaksBin(override) {
  if (override) return override;
  if (process.env.SONAR_GITLEAKS_BIN) return process.env.SONAR_GITLEAKS_BIN;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of [...dirs, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    const candidate = path.join(d, 'gitleaks');
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* ignore */ }
  }
  return '';
}

export function getScannerSignature(binPath = resolveGitleaksBin(), cfgPath = process.env.SONAR_GITLEAKS_CONFIG || '') {
  if (cfgPath) {
    let readable = false;
    try {
      readable = fs.statSync(cfgPath).isFile();
      if (readable) fs.accessSync(cfgPath, fs.constants.R_OK);
    } catch { readable = false; }
    if (!readable) {
      throw new Error(`Configured Gitleaks config not found or unreadable: ${cfgPath}`);
    }
  }
  if (cachedSignature && cachedSignature.binPath === binPath && cachedSignature.cfgPath === cfgPath) {
    return cachedSignature;
  }
  const hasBin = Boolean(binPath && fs.existsSync(binPath));
  if (!hasBin) {
    const sig = {
      available: false,
      binPath,
      cfgPath,
      version: 'regex-fallback-v2',
      rulesHash: 'builtin',
      signature: 'regex-fallback-v2:builtin'
    };
    cachedSignature = sig;
    return sig;
  }
  const ver = spawnSync(binPath, ['version'], { encoding: 'utf8', timeout: 5000 });
  const version = (ver.stdout || ver.stderr || 'unknown').trim().slice(0, 64);
  const rulesHash = cfgPath ? sha(fs.readFileSync(cfgPath)).slice(0, 16) : 'gitleaks-default';
  const sig = {
    available: true,
    binPath,
    cfgPath: cfgPath || '',
    version,
    rulesHash,
    signature: `${version}:${rulesHash}`
  };
  cachedSignature = sig;
  return sig;
}

const FALLBACK_SECRET_PATTERNS = [
  /\b(sk-ant-api\d{2}-[A-Za-z0-9_-]{20,})\b/,
  /\b(sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/,
  /\b([sr]k_(?:live|test)_[0-9A-Za-z]{20,})\b/,
  /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  /\b(hf_[A-Za-z0-9]{20,})\b/,
  /\b(npm_[A-Za-z0-9]{20,})\b/,
  /\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/,
  /-----BEGIN (?:ENCRYPTED |RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
  /\b(A(?:K|S)IA[0-9A-Z]{16})\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^/\s:@]+:[^/\s@]{6,}@[^\s]+/i,
  /(?:aws_secret_access_key|secret_access_key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/i
];

function fallbackHasSecret(text) {
  return FALLBACK_SECRET_PATTERNS.some((re) => re.test(text));
}

export function screenSources(sources, stateRoot, options = {}) {
  const explicitGitleaks = Boolean(
    options.binPath || process.env.SONAR_GITLEAKS_BIN || options.cfgPath || process.env.SONAR_GITLEAKS_CONFIG
  );
  const binPath = resolveGitleaksBin(options.binPath);
  const cfgPath = options.cfgPath ?? process.env.SONAR_GITLEAKS_CONFIG ?? '';
  const requireGitleaks = options.requireGitleaks ?? explicitGitleaks;
  const scanner = getScannerSignature(binPath, cfgPath);

  if (!scanner.available) {
    if (requireGitleaks) {
      throw new Error(`Gitleaks not available (${binPath || 'not in PATH'}); refusing indexing.`);
    }
    if (!fallbackWarned && !options.silentFallback) {
      fallbackWarned = true;
      console.error('[sonar] Warning: gitleaks binary not found in PATH; using built-in regex secret fallback.');
    }
    const safe = [];
    const excluded = [];
    for (const s of sources) {
      const payload = `${s.key || ''}\n${s.text || ''}`;
      if (fallbackHasSecret(payload)) {
        excluded.push({ id: s.id, reason: 'possible-secret (fallback-regex); excluded from knowledge retrieval' });
      } else {
        safe.push(s);
      }
    }
    return { safe, excluded, scannerSignature: scanner.signature };
  }

  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const prevPath = path.join(stateRoot, 'secret-screen-state-v2.json');
  let old = {};
  try {
    old = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
  } catch { /* first run */ }

  let scanDir = null;
  const pending = [];
  try {
    for (const s of sources) {
      const contentHash = s.hash || sha(String(s.text || ''));
      const cacheKey = `${scanner.signature}:${contentHash}`;
      if (old[s.id]?.cacheKey === cacheKey) continue;
      if (!scanDir) scanDir = fs.mkdtempSync(path.join(stateRoot, 'secret-scan-'));
      const file = sha(s.id) + '.txt';
      fs.writeFileSync(path.join(scanDir, file), `${s.key || ''}\n${s.text || ''}`, { mode: 0o600, flag: 'wx' });
      pending.push({ id: s.id, cacheKey, file });
    }

    if (pending.length && scanDir) {
      const reportPath = path.join(scanDir, 'report.json');
      const glArgs = ['dir', scanDir, '--no-banner', '--redact', '--report-format', 'json', '--report-path', reportPath];
      if (scanner.cfgPath) glArgs.push('--config', scanner.cfgPath);
      const r = spawnSync(scanner.binPath, glArgs, { encoding: 'utf8', timeout: 180000 });
      if (![0, 1].includes(r.status)) {
        throw new Error(`Secret scan failed (exit ${r.status}); refusing indexing`);
      }
      const findings = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : [];
      const blockedFiles = new Set(findings.map((f) => path.basename(f.File || '')));
      for (const e of pending) {
        old[e.id] = { cacheKey: e.cacheKey, blocked: blockedFiles.has(e.file) };
      }
      const tmp = `${prevPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(old), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, prevPath);
    }
  } finally {
    if (scanDir) fs.rmSync(scanDir, { recursive: true, force: true });
  }

  const safe = sources.filter((s) => !old[s.id]?.blocked);
  const excluded = sources
    .filter((s) => old[s.id]?.blocked)
    .map((s) => ({ id: s.id, reason: 'possible-secret; excluded from knowledge retrieval' }));
  return { safe, excluded, scannerSignature: scanner.signature };
}

export function screenSingleWrite(key, value, stateRoot, options = {}) {
  const hash = sha(`${key}\0${value}`);
  const res = screenSources([{ id: `write:${hash}`, key, text: value, hash }], stateRoot, options);
  return {
    blocked: res.excluded.length > 0,
    scannerSignature: res.scannerSignature
  };
}
