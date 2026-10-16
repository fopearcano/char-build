// Localizes the builder's data — McKee's catalog and the sixteen stations —
// in place. Every display string (labels, descriptions, principles,
// questions, hints, placeholders…) is recorded once in English and can be
// switched to any registered locale and back. Ids, paths and stored option
// values never change, so saved characters stay valid in every language.

import * as K from './catalog.js';
import { SECTIONS, PARTS, STORY_FIELDS } from './sections.js';
import { dictionary, DEFAULT_LOCALE } from './i18n.js';

const TEXT_KEYS = new Set([
  'label', 'desc', 'short', 'left', 'right', 'madMen', 'twist', 'coreValue', 'coreEvent', 'coreEmotion', 'quality',
  'title', 'subtitle', 'principle', 'hint', 'placeholder', 'help',
]);
const TEXT_ARRAYS = new Set(['questions']);
// Kept in English: stored as values (coreCast) or used as keys (group).
const SKIP_KEYS = new Set(['coreCast', 'group', 'showIf', 'id', 'path', 'type', 'component', 'key']);

let slots = null; // [{ obj, key, en, ctx }]
const originals = new WeakMap(); // obj → Map(key → English)

function record(obj, key, ctx = '') {
  const en = obj[key];
  if (typeof en !== 'string' || !en.trim()) return;
  slots.push({ obj, key, en, ctx });
  if (!originals.has(obj)) originals.set(obj, new Map());
  originals.get(obj).set(key, en);
}

// `ctx` is the catalog list a string belongs to, so a dictionary can give the
// same English word two senses ("Fantasy" the genre vs. the past-effect).
function walk(node, seen, ctx) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, seen, ctx);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (SKIP_KEYS.has(k)) continue;
    if (typeof v === 'string' && TEXT_KEYS.has(k)) record(node, k, ctx);
    else if (Array.isArray(v) && TEXT_ARRAYS.has(k)) v.forEach((_, i) => record(v, i, ctx));
    else if (v && typeof v === 'object') walk(v, seen, ctx);
  }
}

function collect() {
  if (slots) return slots;
  slots = [];
  const seen = new Set();
  for (const n of Object.keys(K.CHAPTERS)) record(K.CHAPTERS, n);
  for (const pair of K.DIMENSION_SUGGESTIONS) pair.forEach((_, i) => record(pair, i));
  for (const [name, value] of Object.entries(K)) {
    if (name === 'BOOK' || name === 'CHAPTERS' || name === 'DIMENSION_SUGGESTIONS') continue;
    walk(value, seen, name);
  }
  walk(PARTS, seen, 'PARTS');
  walk(SECTIONS, seen, 'SECTIONS');
  walk(STORY_FIELDS, seen, 'STORY_FIELDS');
  return slots;
}

// Switch every recorded string to `lang` (English when it has no entry).
export function localizeData(lang) {
  const dict = lang === DEFAULT_LOCALE ? null : dictionary(lang);
  const has = (k) => dict && Object.prototype.hasOwnProperty.call(dict, k);
  for (const s of collect()) {
    const ctxKey = `${s.ctx}|${s.en}`;
    const hit = has(ctxKey) ? dict[ctxKey] : has(s.en) ? dict[s.en] : null;
    s.obj[s.key] = typeof hit === 'string' && hit ? hit : s.en;
  }
}

// The English original of a localized property, e.g. en(section, 'title').
export function en(obj, key) {
  return originals.get(obj)?.get(key) ?? obj?.[key];
}

// Every English data string, plus values that are translated only for
// display (core-cast positions).
export function dataStrings() {
  const out = new Set(collect().map((s) => s.en));
  for (const g of K.PRIMARY_GENRES) for (const r of g.coreCast) out.add(r);
  return [...out];
}
