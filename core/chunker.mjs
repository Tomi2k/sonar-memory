// Tokenizer-agnostischer, überschriftenbewusster Chunker mit Kontext-Header ("Pfad › H1 › H2").
// Funktioniert sauber sowohl mit BERT WordPiece (MiniLM) als auch SentencePiece/XLM-R (multilingual-e5-small).
// Kein brüchiger WordPiece-Whitespace-Shortcut mehr; deterministisch und schnell.

export const CHUNKER_VERSION = 'sonar-chunker-v2';

const DEFAULT_MAX_CHARS = 1100;      // ~220-260 Tokens für DE+EN (passt bequem in E5 512 & MiniLM 256)
const DEFAULT_OVERLAP_CHARS = 160;   // ~30-40 Tokens Überlappung

/**
 * Extrahiert einen kompakten Kontext-Header ("Projekt › Datei › H1 › H2") für einen Offset im Text.
 */
function buildHeaderPrefix(meta, h1, h2) {
  const parts = [];
  if (meta?.project && meta.project !== 'global') parts.push(meta.project);
  if (meta?.key) parts.push(meta.key);
  if (h1 && h1 !== meta?.key) parts.push(h1);
  if (h2 && h2 !== h1) parts.push(h2);
  const label = parts.filter(Boolean).join(' › ');
  return label ? `[${label.slice(0, 180)}]\n` : '';
}

/**
 * Sammelt Markdown-Überschriften (H1/H2/H3) samt Zeichenposition für Kontext-Header.
 */
function scanHeadings(text) {
  const headings = [];
  const re = /^(#{1,3})\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    headings.push({
      pos: m.index,
      level: m[1].length,
      title: m[2].replace(/[#*`]/g, '').trim().slice(0, 90)
    });
  }
  return headings;
}

function headingsAt(headings, pos) {
  let h1 = '';
  let h2 = '';
  for (const h of headings) {
    if (h.pos > pos) break;
    if (h.level === 1) { h1 = h.title; h2 = ''; }
    else if (h.level === 2) { h2 = h.title; }
    else if (h.level === 3 && !h2) { h2 = h.title; }
  }
  return { h1, h2 };
}

/**
 * Zerlegt einen Quelltext in überlappende Passagen entlang Überschriften, Absätzen und Satzgrenzen.
 * Jeder Chunk erhält `start`, `end`, `rawText`, `header` und `embedText` (Header + Passage).
 */
export function chunkText(text, meta = {}, options = {}) {
  const src = String(text || '');
  if (!src.trim()) return [];
  const maxChars = options.maxChars || DEFAULT_MAX_CHARS;
  const overlapChars = options.overlapChars || DEFAULT_OVERLAP_CHARS;
  const headings = scanHeadings(src);

  // Kurze Einträge (z. B. Patterns, Regeln) bleiben immer vollständig in 1 Chunk
  if (src.length <= maxChars) {
    const { h1, h2 } = headingsAt(headings, 0);
    const header = buildHeaderPrefix(meta, h1, h2);
    return [{
      start: 0,
      end: src.length,
      title: [h1, h2].filter(Boolean).join(' › ') || meta?.key || '',
      header,
      rawText: src,
      embedText: header + src
    }];
  }

  const out = [];
  let start = 0;
  const len = src.length;

  while (start < len) {
    let end = Math.min(len, start + maxChars);
    if (end < len) {
      const slice = src.slice(start, end);
      // 1. Bevorzugt an einer Markdown-Überschrift trennen (ab 35 % Fenstergröße)
      const minSplit = Math.floor(slice.length * 0.35);
      let splitAt = -1;
      for (const m of slice.matchAll(/\n#{1,6}\s/g)) {
        if (m.index >= minSplit) splitAt = m.index + 1;
      }
      // 2. Sonst an doppeltem Zeilenumbruch (Absatz)
      if (splitAt < 0) {
        const para = slice.lastIndexOf('\n\n');
        if (para >= minSplit) splitAt = para + 2;
      }
      // 3. Sonst an einfachem Zeilenumbruch oder Satzende
      if (splitAt < 0) {
        const nl = slice.lastIndexOf('\n');
        if (nl >= minSplit) splitAt = nl + 1;
      }
      if (splitAt < 0) {
        const sent = slice.lastIndexOf('. ');
        if (sent >= minSplit) splitAt = sent + 2;
      }
      if (splitAt > 0) end = start + splitAt;
    }

    const rawText = src.slice(start, end);
    if (rawText.trim()) {
      const { h1, h2 } = headingsAt(headings, start);
      const header = buildHeaderPrefix(meta, h1, h2);
      out.push({
        start,
        end,
        title: [h1, h2].filter(Boolean).join(' › ') || meta?.key || '',
        header,
        rawText,
        embedText: header + rawText
      });
    }

    if (end >= len) break;
    const stepBack = Math.min(overlapChars, Math.floor((end - start) / 4));
    let nextStart = Math.max(start + 1, end - stepBack);
    // An Wortgrenze ausrichten
    if (nextStart > start + 1 && nextStart < len) {
      const ws = src.indexOf(' ', nextStart);
      if (ws > nextStart && ws < end) nextStart = ws + 1;
    }
    start = nextStart;
  }

  return out;
}
