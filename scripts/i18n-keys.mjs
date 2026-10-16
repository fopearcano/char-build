// Collects every English string the interface can show: the builder's data
// (catalog, stations), the literal keys passed to t()/tn()/tr()/… in the
// source, McKee check titles, provider names and server messages.
//
//   node scripts/i18n-keys.mjs            → list keys missing from each locale
//   node scripts/i18n-keys.mjs --json it  → missing keys as JSON (for translators)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataStrings } from '../shared/i18n-data.js';
import { PROVIDERS } from '../server/providers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = ['public/js', 'shared', 'server', 'server/llm'];

// function name → indexes of the arguments that are keys
const CALLS = { t: [0], tHtml: [0], tn: [1, 2], tr: [1], trn: [2, 3], i18nError: [1], say: [0], check: [2, 3] };
const CALL_RE = new RegExp(`(?<![\\w.$])(${Object.keys(CALLS).join('|')})\\(`, 'g');

// Labels translated through a variable (t(shape.label), t(group) …).
const EXTRA = ['Dimensions', 'Personae', 'Turning points', 'Scenes', 'Relationships', 'Ch.'];

function splitArgs(src, start) {
  const args = [];
  let depth = 0;
  let cur = '';
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      cur += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) {
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  return args;
}

function literal(arg) {
  if (!/^(['"])(?:\\.|(?!\1).)*\1$/s.test(arg) && !/^`[^`$]*`$/.test(arg)) return null;
  return Function(`"use strict"; return (${arg});`)();
}

function scanFile(file, out) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(CALL_RE)) {
    const args = splitArgs(src, m.index + m[0].length);
    for (const i of CALLS[m[1]]) {
      const v = args[i] != null ? literal(args[i]) : null;
      if (typeof v === 'string' && v.trim()) out.add(v);
    }
  }
  // Prompt chips and other English constants rendered through t(variable).
  for (const name of ['COACH_PROMPTS', 'INTERVIEW_PROMPTS']) {
    const block = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`))?.[1];
    if (block) for (const lit of block.matchAll(/'(?:\\.|[^'\\])*'/g)) out.add(literal(lit[0]));
  }
  for (const m of src.matchAll(/new HttpError\(\d+, ('(?:\\.|[^'\\])*')\)/g)) out.add(literal(m[1]));
  for (const m of src.matchAll(/reasonKey: ('(?:\\.|[^'\\])*')/g)) out.add(literal(m[1]));
}

export function collectKeys() {
  const out = new Set(dataStrings());
  for (const dir of SOURCES) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (f.endsWith('.js') && !f.startsWith('sample-')) scanFile(path.join(ROOT, dir, f), out);
    }
  }
  for (const p of PROVIDERS) {
    out.add(p.label);
    if (p.note) out.add(p.note);
  }
  for (const k of EXTRA) out.add(k);
  return [...out].filter((k) => typeof k === 'string' && k.trim()).sort();
}

export const placeholders = (s) => (String(s).match(/\{\w+\}/g) || []).sort();

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const keys = collectKeys();
  const only = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
  for (const id of only ? [only] : ['it']) {
    const dict = (await import(`../shared/locales/${id}.js`).catch(() => ({ default: {} }))).default;
    const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    const bad = keys.filter((k) => dict[k] && placeholders(k).join() !== placeholders(dict[k]).join());
    if (only) {
      process.stdout.write(`${JSON.stringify(missing, null, 1)}\n`);
    } else {
      console.log(`${id}: ${keys.length} keys, ${missing.length} missing, ${bad.length} with mismatched {placeholders}`);
      for (const k of missing.slice(0, 40)) console.log(`  missing: ${k}`);
      for (const k of bad) console.log(`  placeholders: ${k}`);
    }
  }
}
