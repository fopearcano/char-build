// Interface languages. English strings are the keys: t('Save') looks the
// string up in the active locale's dictionary and falls back to English,
// so untranslated text still reads. Placeholders use {name}.
//
// The browser keeps one active locale (setLocale); the server passes the
// request's language explicitly with tr(lang, …), since requests in
// different languages interleave.

export const LOCALES = [
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'it', label: 'Italiano', short: 'IT' },
];
export const LOCALE_IDS = LOCALES.map((l) => l.id);
export const DEFAULT_LOCALE = 'en';

const DICTS = { en: {} };
let current = DEFAULT_LOCALE;

// "it", "it-IT", "it_IT.UTF-8" → "it"; anything unknown → null.
export function matchLocale(value) {
  const base = String(value || '').trim().toLowerCase().split(/[-_.;,\s]/)[0];
  return LOCALE_IDS.includes(base) ? base : null;
}

export const normalizeLocale = (value) => matchLocale(value) || DEFAULT_LOCALE;

export function registerLocale(id, dict) {
  DICTS[id] = { ...(DICTS[id] || {}), ...dict };
}

export const hasLocale = (id) => !!DICTS[id] && (id === DEFAULT_LOCALE || Object.keys(DICTS[id]).length > 0);
export const dictionary = (id) => DICTS[id] || null;

export function setLocale(id) {
  current = normalizeLocale(id);
  return current;
}

export const getLocale = () => current;

export function format(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

export function tr(lang, s, vars) {
  if (s == null) return '';
  const d = DICTS[lang];
  const hit = d && Object.prototype.hasOwnProperty.call(d, s) ? d[s] : null;
  return format(typeof hit === 'string' && hit ? hit : String(s), vars);
}

export const t = (s, vars) => tr(current, s, vars);

// Singular/plural pair; {n} is filled in.
export function tn(n, one, other, vars = {}) {
  return t(n === 1 ? one : other, { n, ...vars });
}

export function trn(lang, n, one, other, vars = {}) {
  return tr(lang, n === 1 ? one : other, { n, ...vars });
}

// An Error whose message can be shown in the requester's language.
export function i18nError(status, key, vars) {
  return Object.assign(new Error(format(key, vars)), { status, i18n: { key, vars } });
}

// Provider names ("Ollama (local)") are translated too; other values are
// shown as given.
export function localizeError(err, lang) {
  if (err?.i18n) {
    const vars = err.i18n.vars?.provider ? { ...err.i18n.vars, provider: tr(lang, err.i18n.vars.provider) } : err.i18n.vars;
    return tr(lang, err.i18n.key, vars);
  }
  return tr(lang, err?.message || String(err));
}
