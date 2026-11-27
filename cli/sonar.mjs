#!/usr/bin/env node
// Sonar CLI: connects via local Unix socket or remote SSH stdio.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome } from '../core/paths.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];

const TOOL_MAP = {
  search: 'memory_search_unified',
  store: 'memory_store',
  retrieve: 'memory_retrieve',
  get: 'memory_retrieve',
  list: 'memory_list',
  delete: 'memory_delete',
  purge: 'memory_purge',
  supersede: 'memory_supersede',
  conflict: 'memory_flag_conflict',
  resolve: 'memory_resolve',
  history: 'memory_history',
  source: 'memory_source',
  sources: 'memory_sources',
  stats: 'memory_stats',
  doctor: 'memory_stats'
};

function readClientConfig() {
  const candidates = [
    process.env.SONAR_CLIENT_CONFIG ? expandHome(process.env.SONAR_CLIENT_CONFIG) : null,
    path.join(os.homedir(), '.config', 'sonar', 'client.json'),
    path.join(os.homedir(), '.config', 'sonar', 'config.json')
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* ignore */ }
  }
  return {};
}

const SAFE_SSH_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/;
const SAFE_BIN_PATH_RE = /^[a-zA-Z0-9_./-]{1,256}$/;

function quotePosix(s) {
  return "'" + String(s).replaceAll("'", "'\\''") + "'";
}

function resolveProxyCommand() {
  const cfg = readClientConfig();
  const extraEnv = (!process.env.SONAR_SOCKET && typeof cfg.socket === 'string' && cfg.socket.trim())
    ? { ...process.env, SONAR_SOCKET: expandHome(cfg.socket.trim()) }
    : process.env;
  const envBin = process.env.SONAR_MCP_BIN ? expandHome(process.env.SONAR_MCP_BIN) : '';
  if (envBin && fs.existsSync(envBin)) {
    return { bin: envBin, baseArgs: [], isSsh: false, env: extraEnv };
  }
  const cfgBin = cfg.mcpBin ? expandHome(cfg.mcpBin) : '';
  if (cfgBin && fs.existsSync(cfgBin)) return { bin: cfgBin, baseArgs: [], isSsh: false, env: extraEnv };
  // Prefer configured SSH remote host over local wrapper fallback unless SONAR_SOCKET or client.json socket targets a local socket
  const explicitLocal = Boolean((process.env.SONAR_SOCKET || cfg.socket) && !process.env.SONAR_SSH_HOST);
  const sshHost = explicitLocal ? '' : (process.env.SONAR_SSH_HOST || cfg.sshHost || '');
  if (sshHost) {
    if (!SAFE_SSH_HOST_RE.test(sshHost)) {
      throw new Error(`Invalid SONAR_SSH_HOST: ${sshHost}`);
    }
    const remoteBin = process.env.SONAR_REMOTE_BIN || cfg.remoteBin || '/usr/local/bin/sonar-mcp';
    if (!SAFE_BIN_PATH_RE.test(remoteBin)) {
      throw new Error(`Invalid SONAR_REMOTE_BIN: ${remoteBin}`);
    }
    return { bin: 'ssh', baseArgs: ['-T', '-o', 'BatchMode=yes', '--', sshHost, quotePosix(remoteBin)], isSsh: true, env: process.env };
  }
  const localUserBin = path.join(os.homedir(), '.local', 'bin', 'sonar-mcp');
  if (fs.existsSync(localUserBin)) return { bin: localUserBin, baseArgs: [], isSsh: false, env: extraEnv };
  if (fs.existsSync('/usr/local/bin/sonar-mcp')) return { bin: '/usr/local/bin/sonar-mcp', baseArgs: [], isSsh: false, env: extraEnv };
  const bundled = fileURLToPath(new URL('../server/client.py', import.meta.url));
  return { bin: 'python3', baseArgs: [bundled], isSsh: false, env: extraEnv };
}

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`Sonar CLI — Zentraler Agenten-Speicherdienst

Verwendung:
  sonar mcp                                       MCP stdio Server starten
  sonar search --query "<Text>" [--limit 10] [--project X] [--rerank auto|off|deep]
  sonar store --key "<Key>" --value "<Text>" [--namespace patterns] [--supersedes "<Alt>"]
  sonar retrieve --key "<Key>" [--namespace patterns]
  sonar delete --key "<Key>" [--namespace patterns]
  sonar supersede --old-ref "<Alt>" --new-ref "<Neu>" [--reason "<Grund>"]
  sonar conflict --ref-a "<A>" --ref-b "<B>" [--reason "<Grund>"]
  sonar resolve --relation-id <N> --winner-ref "<Sieger>" [--reason "<Grund>"]
  sonar history --ref "<Ref>"
  sonar stats | doctor
`);
  process.exit(0);
}

const { bin, baseArgs, isSsh, env } = resolveProxyCommand();

if (cmd === 'mcp') {
  const r = spawnSync(bin, baseArgs, { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}

const toolName = TOOL_MAP[cmd];
if (!toolName) {
  console.error(`Unbekannter Befehl: ${cmd}. Nutze "sonar --help".`);
  process.exit(2);
}

const args = {};
for (let i = 1; i < argv.length; i++) {
  const token = argv[i];
  if (!token.startsWith('--')) {
    if (cmd === 'search' && !args.query) { args.query = token; continue; }
    throw new Error(`Unerwartetes Argument: ${token}`);
  }
  const k = token.slice(2).replaceAll('-', '_');
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) {
    args[k] = true;
  } else {
    i++;
    if (['limit', 'offset', 'threshold', 'ttl', 'relation_id', 'rerank_k', 'rerank_timeout_ms'].includes(k)) {
      args[k] = Number(next);
    } else if (['upsert', 'confirm', 'confirm_rule_write', 'confirm_rule_supersede', 'include_history', 'include_archive', 'lexical_only', 'supersede_loser', 'smart'].includes(k)) {
      if (next !== 'true' && next !== 'false') {
        throw new Error(`Ungültiger boolescher Wert für --${k.replaceAll('_', '-')}: "${next}" (erwartet: true oder false)`);
      }
      args[k] = next === 'true';
    } else if (k === 'tags' || k === 'namespaces') {
      args[k] = next.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      args[k] = next;
    }
  }
}

if (isSsh) {
  // Send JSON-RPC payload safely via stdin (never unquoted CLI args through remote shell!)
  const rpcLine = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }) + '\n';
  const r = spawnSync(bin, baseArgs, { input: rpcLine, stdio: ['pipe', 'inherit', 'inherit'], env });
  process.exit(r.status ?? 1);
} else {
  const r = spawnSync(bin, [...baseArgs, toolName, JSON.stringify(args)], { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}
