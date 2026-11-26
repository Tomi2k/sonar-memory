// P1 Korpus-Hygiene: 2-Stufen-Allowlist (curated = FTS5 + INT8-Vektor, archive = nur FTS5, excluded = raus),
// Worktree- & .expires-Erkennung, Klassifikation von `kind` (rule|state|pattern|event) und Vertrauensstufe.
// 100 % generisch; optionale eigene Regeln können über `policyFile` (JSON) geladen werden.
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../core/paths.mjs';

export const POLICY_VERSION = 'sonar-policy-v3';

const DEFAULT_SKIP_DIRS = [
  '.git', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build',
  '.cache', 'cache', 'plugins', 'upstream', 'backups', '.pytest_cache', 'target', 'coverage',
  '.tmp', 'tmp'
];

const DEFAULT_HARD_EXCLUDE_PATTERNS = [
  'THIRD-PARTY-LICENSES',
  '^LICENSE(?:\\.txt)?\\.md$',
  'package-lock\\.json\\.md$',
  'tsconfig.*\\.json\\.md$'
];

const DEFAULT_ARCHIVE_PATTERNS = [
  '(^|/)\\.scratch(/|$)',
  '(^|/)(?:archive|backup|backups|retired|transcripts)(/|$)',
  '\\.json\\.md$',
  '\\.html?\\.md$',
  '\\.pdf\\.md$',
  '\\.txt\\.md$'
];

// No unanchored patterns by default: untrusted third-party repos under ~/projects
// must never auto-escalate to non-expiring `own-rule` or bypass archive filters.
// Configure explicit `trustedRoots` (or `extraCoreCuratedPatterns`) in policy.json.
const DEFAULT_CORE_CURATED_PATTERNS = [];

const DEFAULT_PROJECT_RULES = [
  { regex: '(?:^|/)projects/([^/]+)/', group: 1 },
  { regex: '(?:^|/)workspaces/([^/]+)/', group: 1 }
];

export const MAX_CURATED_BYTES = 512 * 1024;      // 512 KB → größere Dateien nur FTS5
export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024; // 4 MB → noch größere Rohdateien ganz raus

function compileRegexList(list = []) {
  return list.map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));
}

export function createPolicy(override = null, extra = {}) {
  let raw = override || {};
  if (typeof override === 'string') {
    const resolved = path.resolve(expandHome(override));
    raw = fs.existsSync(resolved) ? JSON.parse(fs.readFileSync(resolved, 'utf8')) : {};
  }
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(raw.extraSkipDirs || [])]);
  const hardExclude = compileRegexList([...DEFAULT_HARD_EXCLUDE_PATTERNS, ...(raw.extraHardExcludePatterns || [])]);
  const archivePatterns = compileRegexList([...DEFAULT_ARCHIVE_PATTERNS, ...(raw.extraArchivePatterns || [])]);
  const coreCurated = compileRegexList([...DEFAULT_CORE_CURATED_PATTERNS, ...(raw.extraCoreCuratedPatterns || [])]);
  const worktreeDirPatterns = compileRegexList(raw.extraWorktreeDirPatterns || []);
  const projectRules = [...(raw.projectRules || []), ...DEFAULT_PROJECT_RULES].map((r) => ({
    re: r.re instanceof RegExp ? r.re : new RegExp(r.regex),
    group: r.group ?? 1,
    prefix: r.prefix || ''
  }));
  const trustedRoots = [...(raw.trustedRoots || []), ...(extra.trustedRoots || [])]
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => path.resolve(expandHome(p.trim())));
  const maxCuratedBytes = Number(raw.maxCuratedBytes || MAX_CURATED_BYTES);
  const maxArchiveBytes = Number(raw.maxArchiveBytes || MAX_ARCHIVE_BYTES);

  return {
    version: raw.version || POLICY_VERSION,
    skipDirs,
    hardExclude,
    archivePatterns,
    coreCurated,
    worktreeDirPatterns,
    projectRules,
    trustedRoots,
    maxCuratedBytes,
    maxArchiveBytes
  };
}

const DEFAULT_POLICY = createPolicy();
export const SKIP_DIRS = DEFAULT_POLICY.skipDirs;

/**
 * Prüft mit strikter Pfadpräfix-Grenze, ob eine Datei innerhalb eines explizit
 * konfigurierten `trustedRoots`-Verzeichnisses liegt.
 */
export function isTrustedSource(source, policy = DEFAULT_POLICY) {
  const roots = policy?.trustedRoots;
  if (!Array.isArray(roots) || roots.length === 0) return false;
  const full = source?.fullPath ? path.resolve(source.fullPath) : null;
  if (!full) return false;
  return roots.some((root) => full === root || full.startsWith(root + path.sep));
}

/**
 * Prüft auf Verzeichnisebene, ob ein Ordner komplett übersprungen wird (Worktree, .expires, State-History).
 */
export function shouldSkipDirectory(dirPath, dirName, policy = DEFAULT_POLICY) {
  if (policy.skipDirs.has(dirName)) return 'skip-dir';
  if (fs.existsSync(path.join(dirPath, '.expires'))) return 'expires-folder';
  // Git-Worktrees haben eine .git-DATEI statt eines .git-Verzeichnisses
  const gitMarker = path.join(dirPath, '.git');
  try {
    if (fs.existsSync(gitMarker) && fs.statSync(gitMarker).isFile()) return 'git-worktree';
  } catch { /* ignore */ }
  for (const re of policy.worktreeDirPatterns) {
    if (re.test(dirName)) return 'configured-worktree';
  }
  return null;
}

/**
 * Bestimmt das Projekt aus einem relativen Pfad anhand konfigurierbarer Regeln.
 */
export function detectProject(relativePath, policy = DEFAULT_POLICY) {
  const rel = relativePath.split(path.sep).join('/');
  for (const rule of policy.projectRules) {
    const m = rel.match(rule.re);
    if (m && m[rule.group]) return `${rule.prefix}${m[rule.group]}`;
  }
  return 'global';
}

/**
 * Klassifiziert `kind` für Punkt 2.3 (Zeitverfall-Regeln: `rule` verfällt NIE —
 * daher wird `rule` bei Markdown-Dateien ausschließlich innerhalb explizit
 * konfigurierter `trustedRoots` vergeben!).
 */
export function classifyKind(source, policy = DEFAULT_POLICY) {
  if (source.kind) return source.kind;
  const rel = String(source.relativePath || source.id || '').split(path.sep).join('/');
  const ns = source.namespace || '';
  if (isTrustedSource(source, policy) && /(?:^|\/)(?:policies\/|rules\/|CLAUDE\.md$|AGENTS\.md$)/i.test(rel)) {
    return 'rule';
  }
  if (/(?:^|\/)STATE\.md$/i.test(rel)) return 'state';
  if (/(?:^|\/)LOG\.md$/i.test(rel) || ns === 'episodes') return 'event';
  if (ns === 'patterns' || ns === 'reasoning_patterns') return 'pattern';
  return 'doc';
}

/**
 * Klassifiziert Herkunft / Vertrauensstufe (Prompt-Injection-Transparenz).
 * `own-rule` wird ausschließlich für Dateien in explizit konfigurierten `trustedRoots` vergeben.
 */
export function classifyTrust(source, policy = DEFAULT_POLICY) {
  if (source.id?.startsWith('memory_entries:')) return 'internal-memory';
  const rel = String(source.relativePath || source.id || '').split(path.sep).join('/');
  if (isTrustedSource(source, policy) && /(?:^|\/)(?:policies\/|rules\/|CLAUDE\.md$|AGENTS\.md$)/i.test(rel)) {
    return 'own-rule';
  }
  if (source.tier === 'archive') return 'archive-doc';
  return 'workspace-doc';
}

/**
 * Entscheidet über die Stufe einer Markdown-Quelle:
 * - 'curated': FTS5 + INT8-Vektoren
 * - 'archive': nur FTS5 (voll durchsuchbar, 0 Vektor-Ballast)
 * - 'exclude': komplett ausgeschlossen
 */
export function classifyMarkdownSource(relativePath, fileName, byteSize, policy = DEFAULT_POLICY) {
  const rel = relativePath.split(path.sep).join('/');
  if (byteSize <= 0) return { tier: 'exclude', reason: 'empty' };
  if (byteSize > policy.maxArchiveBytes) return { tier: 'exclude', reason: 'oversize-over-limit' };

  for (const re of policy.hardExclude) {
    if (re.test(fileName) || re.test(rel)) return { tier: 'exclude', reason: 'hard-exclude-pattern' };
  }

  // Kuratierte Kernquellen immer in Tier 1 (solange <= maxCuratedBytes)
  for (const re of policy.coreCurated) {
    if (re.test(rel) && byteSize <= policy.maxCuratedBytes) {
      return { tier: 'curated', reason: 'core-curated' };
    }
  }

  for (const re of policy.archivePatterns) {
    if (re.test(rel) || re.test(fileName)) {
      return { tier: 'archive', reason: 'archive-or-derived-fts-only' };
    }
  }

  // LOG.md und große Dateien > 512 KB → Tier 2 (nur FTS5, keine Vektoren)
  if (/\/LOG\.md$/i.test(rel) || byteSize > policy.maxCuratedBytes) {
    return { tier: 'archive', reason: 'large-or-log-fts-only' };
  }

  return { tier: 'curated', reason: 'workspace-curated' };
}
