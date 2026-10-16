// A flat index of every editable path in the character model, derived from
// the builder sections. Used to validate and apply updates proposed by the
// AI coach (or imported), so nothing can write outside the schema.

import * as K from './catalog.js';
import { SECTIONS, sectionFields } from './sections.js';
import { getPath, setPath, uid, isPlainObject } from './model.js';
import { t, getLocale } from './i18n.js';

const LIST_SHAPES = {
  dimensions: {
    label: 'Dimensions',
    section: 'dimensions',
    item: {
      positive: 'text', negative: 'text', type: { enum: K.DIMENSION_TYPES.map((t) => t.id) },
      level: { enum: K.SELF_LEVELS.map((s) => s.id) }, defining: 'boolean',
      positiveExample: 'text', negativeExample: 'text', consistent: 'boolean', variable: 'boolean', unresolvable: 'boolean',
    },
    required: ['positive', 'negative'],
  },
  'selves.personae': {
    label: 'Personae', section: 'selves',
    item: { with: 'text', axis: { enum: ['power', 'intimacy'] }, persona: 'text' },
    required: ['with', 'persona'],
  },
  'arc.turningPoints': {
    label: 'Turning points', section: 'arc',
    item: { label: 'text', charge: { min: -5, max: 5 } },
    required: ['label', 'charge'],
  },
  'action.scenes': {
    label: 'Scenes', section: 'action',
    item: {
      title: 'text', objective: 'text', action: 'text', expectation: 'text', counteraction: 'text',
      source: { enum: K.COUNTERACTION_SOURCES.map((s) => s.id) }, surprise: 'text', value: 'text',
      from: { min: -5, max: 5 }, to: { min: -5, max: 5 }, reaction: 'text', next: 'text',
    },
    required: ['title'],
  },
  relationships: {
    label: 'Relationships', section: 'relationships',
    item: {
      targetId: 'ref-character', kind: { enum: K.RELATIONSHIP_KINDS.map((k) => k.id) },
      effect: { enum: K.RELATIONSHIP_EFFECTS.map((k) => k.id) }, draws: 'text', bringsOut: 'text', dimensionId: 'ref-dimension', notes: 'text',
    },
    required: ['targetId'],
  },
};

// Labels follow the active language, so the index is cached per locale.
const INDEX = new Map();

export function fieldIndex() {
  const cached = INDEX.get(getLocale());
  if (cached) return cached;
  const idx = {};
  const add = (path, def) => {
    if (!idx[path]) idx[path] = def;
  };
  for (const s of SECTIONS) {
    for (const f of sectionFields(s)) {
      const label = f.label || K.EXPLICIT_TRAITS.find((t) => t.id === f.key)?.label || f.path;
      switch (f.type) {
        case 'spectra':
        case 'sliders':
          for (const it of f.items) add(`${f.path}.${it.id}`, { kind: 'number', min: f.min, max: f.max, label: `${label === f.path ? '' : `${label}: `}${it.label}`, section: s.id });
          break;
        case 'slider':
          add(f.path, { kind: 'number', min: f.min, max: f.max, label, section: s.id });
          break;
        case 'chips':
        case 'checklist':
          add(f.path, { kind: 'multi', options: f.options.map((o) => o.id), label, section: s.id });
          break;
        case 'radio':
        case 'select':
          add(f.path, { kind: 'enum', options: f.options.map((o) => o.id), label, section: s.id });
          break;
        case 'toggle':
          add(f.path, { kind: 'boolean', label, section: s.id });
          break;
        case 'trait':
          add(f.path, { kind: 'text', label, section: s.id });
          add(`outer.expressed.${f.key}`, { kind: 'boolean', label: t('{label} is dramatized', { label }), section: s.id });
          break;
        case 'custom':
          break;
        default:
          add(f.path, { kind: 'text', label, section: s.id });
      }
    }
  }
  for (const f of K.ANTAGONISM_FORCES) {
    add(`complexity.antagonism.${f.id}`, { kind: 'number', min: 0, max: 10, label: t('Antagonism: {force}', { force: f.label }), section: 'complexity' });
    add(`complexity.antagonismNotes.${f.id}`, { kind: 'text', label: t('Antagonism note: {force}', { force: f.label }), section: 'complexity' });
  }
  add('complexity.capacity', { kind: 'number', min: 0, max: 10, label: t('Protagonist capacity'), section: 'complexity' });
  add('arc.dimensionId', { kind: 'ref-dimension', label: t('Arc dimension'), section: 'arc' });
  add('genre.coreCastRole', { kind: 'text', label: t('Core-cast position'), section: 'genre' });
  add('action.mo.theme', { kind: 'enum', options: K.MO_THEMES.map((m) => m.id), label: t('MO theme'), section: 'action' });
  for (const [path, shape] of Object.entries(LIST_SHAPES)) add(path, { kind: 'list', ...shape, label: t(shape.label) });
  INDEX.set(getLocale(), idx);
  return idx;
}

export function describeFieldIndex(section) {
  const lines = [];
  for (const [path, d] of Object.entries(fieldIndex())) {
    if (section && d.section !== section) continue;
    let type;
    if (d.kind === 'number') type = `number ${d.min}..${d.max}`;
    else if (d.kind === 'enum') type = `one of [${d.options.join(', ')}]`;
    else if (d.kind === 'multi') type = `array of [${d.options.join(', ')}]`;
    else if (d.kind === 'list') type = `list; append items {${Object.entries(d.item).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : v.enum ? v.enum.join('|') : `${v.min}..${v.max}`}`).join(', ')}}`;
    else type = d.kind;
    lines.push(`${path} — ${d.label} — ${type}`);
  }
  return lines.join('\n');
}

function coerceScalar(kind, def, value, ctx) {
  switch (kind) {
    case 'text':
      if (value == null) return '';
      if (typeof value !== 'string') value = String(value);
      return value.slice(0, 4000);
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) throw new Error('expected a number');
      return Math.max(def.min, Math.min(def.max, Math.round(n * 10) / 10));
    }
    case 'boolean':
      return value === true || value === 'true';
    case 'enum':
      if (value === '' || value == null) return '';
      if (!def.options.includes(value)) throw new Error(`expected one of ${def.options.join(', ')}`);
      return value;
    case 'multi': {
      const arr = Array.isArray(value) ? value : [value];
      const bad = arr.filter((v) => !def.options.includes(v));
      if (bad.length) throw new Error(`unknown option(s) ${bad.join(', ')}; allowed: ${def.options.join(', ')}`);
      return [...new Set(arr)];
    }
    case 'ref-dimension':
      if (value === '' || value == null) return '';
      if (!(ctx.character?.dimensions || []).some((d) => d.id === value) && !(ctx.pendingDimensionIds || []).includes(value)) {
        throw new Error('unknown dimension id');
      }
      return value;
    case 'ref-character':
      if (!(ctx.castIds || []).includes(value)) throw new Error('unknown character id');
      return value;
    default:
      throw new Error(`unsupported kind ${kind}`);
  }
}

function coerceItem(shape, raw, ctx) {
  if (!isPlainObject(raw)) throw new Error('list item must be an object');
  const item = { id: typeof raw.id === 'string' && /^[\w-]{1,60}$/.test(raw.id) ? raw.id : uid('it') };
  for (const [k, spec] of Object.entries(shape.item)) {
    if (raw[k] === undefined) continue;
    if (typeof spec === 'string') item[k] = coerceScalar(spec, {}, raw[k], ctx);
    else if (spec.enum) item[k] = coerceScalar('enum', { options: spec.enum }, raw[k], ctx);
    else item[k] = coerceScalar('number', spec, raw[k], ctx);
  }
  for (const req of shape.required || []) {
    if (item[req] === undefined || item[req] === '') throw new Error(`list item needs "${req}"`);
  }
  return item;
}

// Validate one update {path, value, op}. Returns {ok, update} or {ok:false, error}.
export function validateUpdate(u, ctx = {}) {
  const idx = fieldIndex();
  if (!u || typeof u.path !== 'string') return { ok: false, error: 'missing path' };
  const op = u.op || 'set';
  const def = idx[u.path];
  if (!def) {
    const near = Object.keys(idx).filter((p) => p.split('.').pop() === u.path.split('.').pop()).slice(0, 3);
    return { ok: false, error: `unknown path "${u.path}"${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}` };
  }
  try {
    if (def.kind === 'list') {
      if (op === 'append') return { ok: true, update: { path: u.path, op, value: coerceItem(def, u.value, ctx), label: def.label } };
      if (op === 'set') {
        if (!Array.isArray(u.value)) throw new Error('set on a list needs an array');
        return { ok: true, update: { path: u.path, op, value: u.value.map((v) => coerceItem(def, v, ctx)), label: def.label } };
      }
      throw new Error(`unsupported op "${op}"`);
    }
    if (op === 'append' && def.kind === 'multi') {
      return { ok: true, update: { path: u.path, op, value: coerceScalar('multi', def, u.value, ctx), label: def.label } };
    }
    if (op !== 'set') throw new Error(`op "${op}" only applies to lists and multi-selects`);
    return { ok: true, update: { path: u.path, op, value: coerceScalar(def.kind, def, u.value, ctx), label: def.label } };
  } catch (err) {
    return { ok: false, error: `${u.path}: ${err.message}` };
  }
}

// Apply validated updates to a copy of the character.
export function applyUpdates(character, updates) {
  const next = structuredClone(character);
  for (const u of updates) {
    const cur = getPath(next, u.path);
    if (u.op === 'append') {
      const arr = Array.isArray(cur) ? cur : [];
      const add = Array.isArray(u.value) ? u.value : [u.value];
      setPath(next, u.path, fieldIndex()[u.path]?.kind === 'multi' ? [...new Set([...arr, ...add])] : [...arr, ...add]);
    } else {
      setPath(next, u.path, u.value);
    }
    // Only one defining dimension may stand forward.
    if (u.path === 'dimensions') {
      const dims = getPath(next, 'dimensions') || [];
      const definers = dims.filter((d) => d.defining);
      if (definers.length > 1) {
        const keep = Array.isArray(u.value) ? definers[0] : u.value.defining ? dims[dims.length - 1] : definers[0];
        for (const d of dims) d.defining = d === keep;
      }
    }
  }
  return next;
}
