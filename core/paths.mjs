// Shared path normalization helpers (expands leading "~/" to os.homedir()).
import os from 'node:os';
import path from 'node:path';

export function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveConfigPaths(cfg = {}) {
  const out = { ...cfg };
  for (const key of ['database', 'index', 'modelRoot', 'policyFile', 'telemetryPath']) {
    if (typeof out[key] === 'string' && out[key]) {
      out[key] = path.resolve(expandHome(out[key]));
    }
  }
  // Never call path.resolve() on socket: relative or numeric values (e.g. "8080") must be rejected by _validateSocketPath().
  if (typeof out.socket === 'string' && out.socket) {
    out.socket = expandHome(out.socket);
  }
  if (Array.isArray(out.sources)) {
    out.sources = out.sources.map((s) => (typeof s === 'string' && s ? path.resolve(expandHome(s)) : s)).filter(Boolean);
  }
  if (Array.isArray(out.trustedRoots)) {
    out.trustedRoots = out.trustedRoots.map((s) => (typeof s === 'string' && s ? path.resolve(expandHome(s)) : s)).filter(Boolean);
  }
  if (out.screenOptions && typeof out.screenOptions === 'object') {
    out.screenOptions = { ...out.screenOptions };
    if (typeof out.screenOptions.binPath === 'string' && out.screenOptions.binPath) {
      out.screenOptions.binPath = path.resolve(expandHome(out.screenOptions.binPath));
    }
    if (typeof out.screenOptions.cfgPath === 'string' && out.screenOptions.cfgPath) {
      out.screenOptions.cfgPath = path.resolve(expandHome(out.screenOptions.cfgPath));
    }
  }
  return out;
}
