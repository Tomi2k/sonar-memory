// Versionierte Deutsch/Englisch-Textnormalisierung, Stemmer, Schlüssel-Extraktion & FTS5-Abfragebau.
// Jede Änderung an Normalisierung oder Stemmer erhöht NORM_VERSION und löst Reindex aus.
export const NORM_VERSION = 'norm-de-en-v1';

const STOPWORDS = new Set([
  // Deutsch
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'einen', 'eines',
  'und', 'oder', 'aber', 'doch', 'wie', 'wo', 'was', 'wer', 'warum', 'welche', 'welcher', 'welches', 'welchen',
  'ist', 'sind', 'war', 'waren', 'wird', 'werden', 'wurde', 'wurden', 'sein', 'haben', 'hat', 'hatte',
  'soll', 'sollen', 'muss', 'mussen', 'kann', 'konnen', 'darf', 'durfen', 'will', 'wollen',
  'zu', 'zum', 'zur', 'im', 'in', 'an', 'am', 'auf', 'fuer', 'fur', 'mit', 'von', 'vom', 'nach', 'aus', 'bei', 'beim',
  'ueber', 'uber', 'unter', 'vor', 'hinter', 'zwischen', 'durch', 'gegen', 'ohne', 'um', 'bis', 'seit',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'man', 'sich', 'nicht', 'auch', 'noch', 'nur', 'schon', 'sehr',
  'als', 'wenn', 'weil', 'dass', 'ob', 'hier', 'dort', 'dann', 'jetzt', 'alle', 'alles', 'mehr', 'dieser', 'diese', 'dieses',
  // Englisch
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'where', 'what', 'when', 'why', 'how', 'which', 'who',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'to', 'in', 'on', 'at', 'for', 'with', 'of', 'from', 'by', 'as', 'into', 'about', 'after', 'before',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we', 'our', 'you', 'your', 'not', 'no', 'so'
]);

/**
 * Normalisiert deutsche Umlaute (ä→ae, ö→oe, ü→ue, ß→ss) und Kleinschreibung,
 * sodass „Prüfung“ und „Pruefung“ sowie „Straße“ und „Strasse“ identisch matchen.
 */
export function normalizeText(raw) {
  if (!raw) return '';
  return String(raw)
    .normalize('NFC')
    .toLowerCase()
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .replaceAll('ß', 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Kompakter, deterministischer Deutsch/Englisch-Stemmer (Snowball-inspiriert)
 * ohne externe Native-Abhängigkeit. Wird ausschließlich in der `stem`-Spalte genutzt,
 * während `exact` (2× Gewicht) die ungestemmte normalisierte Form behält.
 */
export function stemWord(w) {
  if (w.length < 5) return w;
  if (/^\d/.test(w) || /[_/.-]/.test(w)) return w;
  // Deutsche Endungen (längste zuerst, ohne Über-Stemming bei -ung/-ungen)
  const deSuffixes = [
    'ungen', 'heiten', 'keiten', 'schaften', 'ierungen',
    'ische', 'ischen', 'ischer', 'isches', 'igkeit',
    'ieren', 'enden', 'endes', 'ender',
    'heit', 'keit', 'lich', 'isch', 'chen', 'lein', 'ment', 'tion',
    'ung', 'ern', 'end', 'est', 'ete', 'ten', 'tet',
    'en', 'er', 'es', 'em', 'te', 'st', 'et', 'e', 's', 'n'
  ];
  for (const s of deSuffixes) {
    if (w.length - s.length >= 4 && w.endsWith(s)) {
      return w.slice(0, -s.length);
    }
  }
  return w;
}

export function tokenizeNormalized(raw, { dropStopwords = false } = {}) {
  const norm = normalizeText(raw);
  const tokens = norm.match(/[a-z0-9][a-z0-9_.-]{1,}/g) || [];
  if (!dropStopwords) return tokens;
  return tokens.filter((t) => !STOPWORDS.has(t));
}

export function normalizeForExactFts(raw) {
  return tokenizeNormalized(raw, { dropStopwords: false }).join(' ');
}

export function normalizeForStemFts(raw) {
  return tokenizeNormalized(raw, { dropStopwords: false }).map(stemWord).join(' ');
}

/**
 * Extrahiert exakte Schlüssel, Ticket-IDs (BUG-1042, FEAT-2099, ADR-101),
 * Entry-IDs, Dateinamen und Commit-Hashes für den B-Tree-Fast-Path (< 5 ms).
 */
export function extractExactKeys(text, extraKeys = []) {
  const keys = new Set();
  const add = (k) => {
    const clean = normalizeText(k).trim();
    if (clean.length >= 3 && clean.length <= 160) keys.add(clean);
  };
  for (const k of extraKeys) {
    if (k) add(k);
  }
  if (!text) return [...keys];
  const str = String(text);

  // Ticket- & Story-IDs: BUG-1042, FEAT-2099, ADR-101, TASK-42
  for (const m of str.matchAll(/\b([A-Z]{2,8}-\d{1,6}(?:-\d{1,3})?)\b/g)) {
    add(m[1]);
    add(m[1].replaceAll('-', ''));
  }
  // Entry-IDs: entry_1700000000000_abcdef1234567890
  for (const m of str.matchAll(/\b(entry_\d+_[a-f0-9]{8,})\b/gi)) {
    add(m[1]);
  }
  // Dateinamen mit Endung: server.mjs, memory.db, gitleaks.toml, STATE.md
  for (const m of str.matchAll(/\b([a-zA-Z0-9_-]{2,60}\.(?:mjs|js|ts|tsx|py|sql|json|toml|md|sh|service|timer|db|swift|yaml|yml))\b/g)) {
    add(m[1]);
  }
  // Bindestrich-Slugs (z. B. backup-restore-runbook-20260115)
  for (const m of str.matchAll(/\b([a-z0-9]+(?:-[a-z0-9]+){2,})\b/gi)) {
    if (m[1].length <= 120) add(m[1]);
  }
  return [...keys];
}

/**
 * Erkennt, ob eine Nutzeranfrage eine direkte Schlüssel-/ID-Abfrage ist (Fast-Path).
 */
export function detectExactQueryKey(query) {
  const q = String(query || '').trim();
  if (!q || q.includes(' ')) return null;
  if (/^entry_\d+_[a-f0-9]+$/i.test(q)) return normalizeText(q);
  if (/^[A-Za-z]{2,8}-\d{1,6}(?:-\d{1,3})?$/.test(q)) return normalizeText(q);
  if (/^[a-z0-9_.-]{4,140}$/i.test(q) && (q.includes('-') || q.includes('_') || q.includes('.') || q.includes(':'))) {
    return normalizeText(q);
  }
  return null;
}

/**
 * Baut eine sichere FTS5-MATCH-Abfrage (schützt vor FTS-Operatoren wie `-`, `:`, `"`, `(`).
 * Durchsucht sowohl `exact` als auch `stem`, damit exakte Treffer 2× und Stämme 1× zählen.
 */
export function buildSafeFtsQuery(query) {
  const rawTokens = tokenizeNormalized(query, { dropStopwords: true });
  const fallbackTokens = rawTokens.length ? rawTokens : tokenizeNormalized(query, { dropStopwords: false });
  // Splits an Punkt/Bindestrich zusätzlich aufnehmen, damit "server.mjs" und "BUG-1042" sicher matchen
  const expanded = [];
  const seen = new Set();
  for (const tok of fallbackTokens.slice(0, 18)) {
    const clean = tok.replace(/[^a-z0-9]/g, ' ').trim();
    for (const part of clean.split(/\s+/)) {
      if (part.length >= 2 && !STOPWORDS.has(part) && !seen.has(part)) {
        seen.add(part);
        expanded.push(part);
      }
    }
  }
  if (!expanded.length) return null;
  const clauses = [];
  for (const t of expanded.slice(0, 14)) {
    const st = stemWord(t);
    const qExact = `"${t.replaceAll('"', '')}"`;
    if (st !== t && st.length >= 4) {
      const qStem = `"${st.replaceAll('"', '')}"`;
      clauses.push(`(exact:${qExact} OR stem:${qStem})`);
    } else {
      clauses.push(`(exact:${qExact} OR stem:${qExact})`);
    }
  }
  return clauses.join(' OR ');
}

/**
 * Extrahiert Suchbegriffe für Trigramm-Identifikator-Suche (mind. 3 Zeichen).
 */
export function extractTrigramTerms(query) {
  const tokens = tokenizeNormalized(query, { dropStopwords: true });
  return [...new Set(tokens.filter((t) => t.length >= 3))].slice(0, 6);
}
