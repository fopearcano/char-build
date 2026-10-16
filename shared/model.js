// Data model: story and character factories plus path helpers.
// The character shape mirrors the order of McKee's argument:
// concept → role → outer (characterization) → selves → inner (true
// character) → dimensions → complexity → arc → symbol → genre → action
// → performance → relationships.

import { t } from './i18n.js';

export const SCHEMA_VERSION = 1;

export function uid(prefix = 'id') {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

export function newStory(fields = {}) {
  const now = new Date().toISOString();
  return deepMerge({
    id: uid('story'),
    schema: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    title: 'Untitled story',
    logline: '',
    media: [],
    format: '',
    causality: '',
    theme: '',
    coreValue: { positive: '', negative: '' },
    genre: { primary: [], presentational: [], combination: '' },
    world: { period: '', duration: '', location: '', levels: [], notes: '' },
    notes: '',
  }, fields);
}

export function newCharacter(fields = {}) {
  const now = new Date().toISOString();
  return deepMerge({
    id: uid('char'),
    schema: SCHEMA_VERSION,
    storyId: null,
    createdAt: now,
    updatedAt: now,
    name: '',
    color: pickColor(),
    concept: {
      nickname: '', roleLabel: '', logline: '', inspiration: [], tellingDetail: '', magicIf: '',
      approach: '', inCharacter: '', research: [], researchNotes: '',
    },
    cast: {
      circle: '', function: '', specialRoles: [], protagonistType: '', essentials: [], essentialsNotes: '',
      centerOfGood: '', foilOf: '', foilFunctions: [],
      narrator: { person: '', reliability: '', cause: '' },
      mapAngle: null,
    },
    outer: {
      explicit: {
        nameMeaning: '', age: '', appearance: '', wardrobe: '', gender: '', eros: '', voice: '', face: '',
        gestures: '', profession: '', recreation: '', home: '', transport: '', knowledge: '', ignorance: '',
        beliefs: '', conversation: '', manners: '', workIdentity: null,
      },
      expressed: {},
      spectra: {},
      implicit: {
        bigFive: {}, intelligence: {}, habitsOfThought: '', flexibility: null,
        likes: '', dislikes: '', fears: '', outlook: null, whoAreYou: '', achieve: '', mustDo: '', mustNever: '',
        humanNature: '', mood: '', temperament: '', authority: null, mirror: '',
      },
      functions: [],
      setting: {
        period: '', location: '', levels: [], physical: '', social: '', personal: '', restraints: '',
        relation: '', extendedSelf: '', change: [], values: '',
      },
      expression: {},
    },
    selves: { social: '', personal: '', core: '', hidden: '', variation: '', personae: [] },
    inner: {
      motivations: {}, moreKind: '', outsideIn: '',
      backstory: { patterns: '', adolescence: '', identity: '' },
      incitingIncident: '', incitingCharge: '', superObjective: '', objectOfDesire: '', desireKind: '',
      dilemma: { kind: '', optionA: '', optionB: '', choice: '' },
      pressure: { risk: null, freedom: null, notes: '' },
      values: {}, emotions: {}, emotionStyle: '', feelings: {}, reactions: '', decisionPath: '',
    },
    dimensions: [],
    complexity: {
      antagonism: {}, antagonismNotes: {}, capacity: null,
      subconsciousDesire: '', innerConflicts: [], depthTraits: [],
      subtext: { text: '', sub: '', unsayable: '' },
      secrets: '',
    },
    arc: {
      need: '', needTypes: [], potential: {}, incitingTuned: '',
      seemsAtStart: '', isAtClimax: '',
      theory: '', type: '', dimensionId: '', from: '', to: '', plot: '', lifeView: '', reaction: '', pastEffect: '',
      turningPoints: [],
      climax: '', epiphany: '', completion: '',
    },
    symbolic: {
      spectrum: null, level: '', archetypes: [], allegory: '', typeAdjective: '', stockJob: '', veil: '',
      stereotypeChecked: false, mode: '', subtractions: [],
    },
    genre: { coreCastRole: '', subplotGenre: '', notes: '' },
    action: {
      selfStory: { past: '', present: '', future: '' },
      mo: { theme: '', description: '', twist: '' },
      probability: '',
      scenes: [],
    },
    performance: { functions: [], discovery: '', recognition: '', curiosity: null, concern: null, notes: '' },
    relationships: [],
    notes: '',
  }, fields);
}

const PALETTE = ['#e4572e', '#4c6ef5', '#12b886', '#f59f00', '#ae3ec9', '#1098ad', '#d6336c', '#5c940d', '#e8590c', '#3b5bdb'];
let colorIndex = Math.floor(Math.random() * PALETTE.length);
export function pickColor() {
  colorIndex = (colorIndex + 1) % PALETTE.length;
  return PALETTE[colorIndex];
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Merge `patch` into a copy of `base`; arrays and scalars from patch win.
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

// Fill any keys missing from an older saved character with fresh defaults.
export function normalizeCharacter(c) {
  const base = newCharacter({ id: c.id, color: c.color || pickColor() });
  return deepMerge(base, c);
}

export function normalizeStory(s) {
  return deepMerge(newStory({ id: s.id }), s);
}

export function getPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(key) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

// Mutates obj; creates intermediate objects as needed. Refuses prototype keys.
export function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (isUnsafeKey(key)) throw new Error(`Unsafe path segment: ${key}`);
    if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    cur = cur[key];
  }
  const last = keys[keys.length - 1];
  if (isUnsafeKey(last)) throw new Error(`Unsafe path segment: ${last}`);
  cur[last] = value;
  return obj;
}

function isUnsafeKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

export function isFilled(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.values(v).some(isFilled);
  return false;
}

export function displayName(c) {
  return (c && c.name && c.name.trim()) || t('Unnamed character');
}
