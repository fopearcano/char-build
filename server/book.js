// Local, in-memory search over the user's own copy of McKee's CHARACTER
// (the .epub in docs/). Nothing is copied into the repo: the book is parsed
// at runtime, split into short passages and ranked with BM25. Used by the
// AI coach (search tool) and the in-app "Book" tab.

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const STOP = new Set(('a an and are as at be but by for from has have he her hers him his i if in into is it its me my no not of on or our she so than that the their them then there these they this to us was we were what when which who whom why will with would you your yours can could did do does done had how just more most much must only other over own same should some such too very about after again all also am any because been before being below between both down during each few further here itself let nor off once out shall since through under until up upon while yet').split(/\s+/));

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<sup[\s\S]*?<\/sup>/gi, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\s+/g, ' ').trim();
}

export function tokenize(text) {
  return (text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z][a-z'-]+/g) || [])
    .map((t) => t.replace(/'s$/, '').replace(/^-+|-+$/g, ''))
    .flatMap((t) => (t.includes('-') ? [t, ...t.split('-')] : [t]))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

// Tiny suffix stripper so "dimensions"/"dimensional" meet "dimension".
function stem(t) {
  for (const suf of ['ational', 'ization', 'iveness', 'fulness', 'ousness', 'ments', 'ment', 'ings', 'ing', 'ies', 'edly', 'ed', 'es', 'al', 's']) {
    if (t.length - suf.length >= 4 && t.endsWith(suf)) return suf === 'ies' ? `${t.slice(0, -3)}y` : t.slice(0, -suf.length);
  }
  return t;
}

const SKIP_TITLES = /^(notes|index|acknowledg|about the author|copyright|contents|also by)/i;

export function parseEpub(file) {
  const zip = new AdmZip(file);
  const read = (p) => {
    const entry = zip.getEntry(p);
    return entry ? entry.getData().toString('utf8') : null;
  };
  const container = read('META-INF/container.xml');
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw new Error('Not a valid EPUB: missing rootfile');
  const opf = read(opfPath);
  const base = path.posix.dirname(opfPath);
  const manifest = {};
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = m[0].match(/\bid="([^"]+)"/)?.[1];
    const href = m[0].match(/\bhref="([^"]+)"/)?.[1];
    if (id && href) manifest[id] = path.posix.normalize(base === '.' ? href : `${base}/${href}`);
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => manifest[m[1]]).filter(Boolean);
  const title = stripTags(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)?.[1] || 'Book');

  const blocks = [];
  let chapterNum = '';
  let chapter = 'Front matter';
  let part = '';
  let section = '';
  let skipping = false;
  for (const href of spine) {
    const html = read(decodeURIComponent(href)) ?? read(href);
    if (!html) continue;
    if (/epub:type="[^"]*rearnote/.test(html)) continue; // endnotes
    for (const m of html.matchAll(/<(h[1-6]|p|li|blockquote)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      const tag = m[1].toLowerCase();
      const cls = m[2].match(/class="([^"]*)"/)?.[1] || '';
      const text = stripTags(m[3]);
      if (!text) continue;
      if (tag[0] === 'h') {
        const level = Number(tag[1]);
        if (/chapter-number/.test(cls)) { chapterNum = text; continue; }
        if (/part-number/.test(cls)) { part = `Part ${text.replace(/^part\s*/i, '')}`; continue; }
        if (/part-title/.test(cls)) { part = `${part ? `${part}: ` : ''}${titleCase(text)}`; continue; }
        if (level === 1 && !/^sect/.test(cls)) {
          chapter = `${chapterNum && /chapter-title/.test(cls) ? `Ch. ${chapterNum} — ` : ''}${titleCase(text)}`;
          section = '';
          skipping = SKIP_TITLES.test(text);
          if (!/chapter-title/.test(cls)) chapterNum = '';
          continue;
        }
        // h1.sect / h2 open a section; h3+ refine it.
        if (level <= 2) section = titleCase(text);
        else section = `${section.split(' › ')[0]} › ${titleCase(text)}`;
        if (/^glossary$/i.test(text)) { chapter = 'Glossary'; section = ''; }
        continue;
      }
      if (skipping) continue;
      blocks.push({ chapter, part, section, text });
    }
  }
  return { title, passages: chunk(blocks) };
}

function titleCase(s) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s:—(-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
}

function chunk(blocks, target = 210) {
  const passages = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.text.trim()) passages.push(cur);
    cur = null;
  };
  for (const b of blocks) {
    if (cur && (cur.chapter !== b.chapter || cur.section !== b.section)) flush();
    if (!cur) cur = { chapter: b.chapter, part: b.part, section: b.section, text: '', words: 0 };
    const w = b.text.split(/\s+/).length;
    if (cur.words && cur.words + w > target * 1.5) {
      flush();
      cur = { chapter: b.chapter, part: b.part, section: b.section, text: '', words: 0 };
    }
    cur.text += (cur.text ? '\n' : '') + b.text;
    cur.words += w;
    if (cur.words >= target) flush();
  }
  flush();
  return passages.map((p, i) => ({ id: i, chapter: p.chapter, part: p.part, section: p.section, text: p.text }));
}

export class BookIndex {
  constructor(passages, title) {
    this.title = title;
    this.passages = passages;
    this.docs = passages.map((p) => {
      const toks = tokenize(`${p.section} ${p.section} ${p.text}`);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      return { tf, len: toks.length };
    });
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
    this.df = new Map();
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
  }

  search(query, limit = 5) {
    const q = [...new Set(tokenize(query))];
    if (!q.length) return [];
    const N = this.docs.length;
    const k1 = 1.4;
    const b = 0.75;
    const scored = [];
    this.docs.forEach((d, i) => {
      let score = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t);
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen)));
      }
      if (score > 0) scored.push([score, i]);
    });
    scored.sort((x, y) => y[0] - x[0]);
    return scored.slice(0, limit).map(([score, i]) => ({ ...this.passages[i], score: Math.round(score * 100) / 100 }));
  }
}

let cached = null;

export function findBookFile(rootDir) {
  if (process.env.BOOK_PATH) return fs.existsSync(process.env.BOOK_PATH) ? process.env.BOOK_PATH : null;
  const docs = path.join(rootDir, 'docs');
  if (!fs.existsSync(docs)) return null;
  const epub = fs.readdirSync(docs).find((f) => f.toLowerCase().endsWith('.epub'));
  return epub ? path.join(docs, epub) : null;
}

export function getBookIndex(rootDir) {
  if (cached) return cached;
  const file = findBookFile(rootDir);
  if (!file) {
    cached = { available: false, reason: 'No .epub found in docs/ (or BOOK_PATH).' };
    return cached;
  }
  try {
    const { title, passages } = parseEpub(file);
    cached = { available: true, file: path.basename(file), title, index: new BookIndex(passages, title), passages: passages.length };
  } catch (err) {
    cached = { available: false, reason: `Could not read ${path.basename(file)}: ${err.message}` };
  }
  return cached;
}

export function bookStatus(rootDir) {
  const b = getBookIndex(rootDir);
  return b.available ? { available: true, file: b.file, title: b.title, passages: b.passages } : { available: false, reason: b.reason };
}

export function searchBook(rootDir, query, limit = 5, maxChars = 1400) {
  const b = getBookIndex(rootDir);
  if (!b.available) return { available: false, reason: b.reason, results: [] };
  const results = b.index.search(query, limit).map((r) => ({
    chapter: r.chapter,
    section: r.section,
    score: r.score,
    text: r.text.length > maxChars ? `${r.text.slice(0, maxChars).replace(/\s+\S*$/, '')}…` : r.text,
  }));
  return { available: true, results };
}
