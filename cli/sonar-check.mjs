#!/usr/bin/env node
// Sonar Health-Check für Terminal-Start, SessionStart-Hooks und `sonar doctor`.
// - Lokal (Unix-Socket): prüft GET /health in < 20 ms
// - Remote (SSH): prüft Remote-Socket mit kurzem Cache (Default 20 s), blockiert nie den Terminalstart
// - Meldet Ausfälle sofort klar als [SONAR-DOWN] mit Wiederherstellungs-Hinweis
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expandHome } from '../core/paths.mjs';

const args = process.argv.slice(2);
const isHook = args.includes('--hook');
const isJson = args.includes('--json');
const noCache = args.includes('--no-cache');
const quietOk = args.includes('--quiet-ok') || isHook;
const timeoutMs = Number(process.env.SONAR_CHECK_TIMEOUT_MS || 3500);
const cacheTtlMs = Number(process.env.SONAR_CHECK_CACHE_MS || 20000);

function readUserConfig() {
  const candidates = [
    process.env.SONAR_CLIENT_CONFIG ? expandHome(process.env.SONAR_CLIENT_CONFIG) : null,
    path.join(os.homedir(), '.config', 'sonar', 'client.json'),
    path.join(os.homedir(), '.config', 'sonar', 'config.json'),
    '/etc/sonar/config.json'
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* ignore */ }
  }
  return {};
}

function checkLocalSocket(sockPath) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (!fs.existsSync(sockPath)) {
      return resolve({ ok: false, error: `Socket nicht gefunden: ${sockPath}`, ms: Date.now() - started });
    }
    const req = http.request({ socketPath: sockPath, path: '/health', method: 'GET', agent: false, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          const ready = Boolean(data?.ok && data?.status?.ready);
          resolve({ ok: ready, status: data?.status || data, error: ready ? null : 'Index not ready', ms: Date.now() - started });
        } catch (err) {
          resolve({ ok: false, error: `Ungültige /health-Antwort: ${err.message}`, ms: Date.now() - started });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: `Socket-Timeout (${timeoutMs} ms)`, ms: Date.now() - started }); });
    req.on('error', (err) => resolve({ ok: false, error: err.message, ms: Date.now() - started }));
    req.end();
  });
}

const SAFE_SSH_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/;
const SAFE_BIN_PATH_RE = /^[a-zA-Z0-9_./-]{1,256}$/;

function quotePosix(s) {
  return "'" + String(s).replaceAll("'", "'\\''") + "'";
}

function sanitizeOutput(text, maxLen = 160) {
  return String(text || '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function checkRemoteViaSsh(sshHost, remoteBin) {
  const started = Date.now();
  if (!SAFE_SSH_HOST_RE.test(sshHost)) {
    return { ok: false, error: `Invalid sshHost: ${sanitizeOutput(sshHost, 64)}`, ms: 0 };
  }
  if (!SAFE_BIN_PATH_RE.test(remoteBin)) {
    return { ok: false, error: `Invalid remoteBin: ${sanitizeOutput(remoteBin, 64)}`, ms: 0 };
  }
  const rpcLine = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'memory_stats', arguments: {} }
  }) + '\n';
  const res = spawnSync(
    'ssh',
    ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '--', sshHost, quotePosix(remoteBin)],
    { input: rpcLine, encoding: 'utf8', timeout: timeoutMs + 1000 }
  );
  if (res.status !== 0) {
    const msg = sanitizeOutput((res.stderr || res.stdout || '').split('\n')[0] || `SSH exit ${res.status}`);
    return { ok: false, error: msg, ms: Date.now() - started };
  }
  try {
    const firstLine = (res.stdout || '').trim().split('\n')[0] || '';
    const parsed = JSON.parse(firstLine);
    const text = parsed?.result?.content?.[0]?.text;
    const status = text ? JSON.parse(text) : (parsed?.status || parsed);
    const ready = Boolean(status?.ready);
    return { ok: ready, status, error: ready ? null : sanitizeOutput(status?.error || 'Service not ready'), ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: sanitizeOutput(`Unreadable response: ${err.message}`), ms: Date.now() - started };
  }
}

function loadCache(cacheFile) {
  if (noCache) return null;
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (data && data.ok && (Date.now() - data.checkedAt) < cacheTtlMs) {
      return { ...data, cached: true };
    }
  } catch { /* ignore */ }
  return null;
}

function saveCache(cacheFile, result) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cacheFile, JSON.stringify({ ...result, checkedAt: Date.now() }), { mode: 0o600 });
  } catch { /* ignore */ }
}

const cfg = readUserConfig();
const explicitLocalSocket = Boolean((process.env.SONAR_SOCKET || cfg.socket) && !process.env.SONAR_SSH_HOST);
const defaultUserSocket = path.join(os.homedir(), '.local', 'share', 'sonar', 'sonar.sock');
const fallbackSocket = (fs.existsSync(defaultUserSocket) || !fs.existsSync('/run/sonar/mcp.sock'))
  ? defaultUserSocket
  : '/run/sonar/mcp.sock';
const localSocket = expandHome(process.env.SONAR_SOCKET || cfg.socket || process.env.SONAR_DEFAULT_SOCKET || fallbackSocket);
const sshHost = explicitLocalSocket ? '' : (process.env.SONAR_SSH_HOST || cfg.sshHost || '');
const remoteBin = process.env.SONAR_REMOTE_BIN || cfg.remoteBin || '/usr/local/bin/sonar-mcp';
const cacheFile = path.join(os.homedir(), '.cache', 'sonar', 'health.json');
const numOrQ = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? String(Number(v)) : '?');

let result = loadCache(cacheFile);
if (!result) {
  if (sshHost && !explicitLocalSocket) {
    result = checkRemoteViaSsh(sshHost, remoteBin);
  } else {
    result = await checkLocalSocket(localSocket);
  }
  if (result.ok) saveCache(cacheFile, result);
}

if (isJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (result.ok) {
  if (!quietOk) {
    const st = result.status || {};
    console.log(
      `[SONAR-OK] ${sanitizeOutput(st.engine || 'sonar', 32)} bereit (${numOrQ(st.sources)} Quellen, ${numOrQ(st.vectors)} Vektoren, ${numOrQ(st.vectorRamMB)} MB RAM, ${numOrQ(result.ms)} ms${result.cached ? ', Cache' : ''})`
    );
  }
  process.exit(0);
}

// Report outage clearly; keep --hook purely informational (no raw control chars or privileged shell commands).
const safeErr = sanitizeOutput(result.error || 'unreachable');
if (isHook) {
  console.log(`[SONAR-DOWN] Memory service unavailable (${safeErr}). Check service status manually.`);
  process.exit(0);
} else {
  console.error(`[SONAR-DOWN] Memory service unavailable (${safeErr}).`);
  process.exit(1);
}
