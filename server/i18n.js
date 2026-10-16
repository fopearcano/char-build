// Server-side languages: registers the dictionaries and works out which
// language a request wants (the app sends X-CharBuild-Lang; anything else
// falls back to Accept-Language, then English).

import { registerLocale, matchLocale, setLocale, LOCALE_IDS, DEFAULT_LOCALE } from '../shared/i18n.js';
import { localizeData } from '../shared/i18n-data.js';
import IT from '../shared/locales/it.js';

registerLocale('it', IT);
// The server's own copy of the catalog always stays in English: it feeds the
// coach's prompts. Requests get their language through tr(lang, …).
localizeData(DEFAULT_LOCALE);

export function requestLang(req) {
  const header = matchLocale(req.get?.('x-charbuild-lang'));
  if (header) return header;
  const accepted = typeof req.acceptsLanguages === 'function' && req.get?.('accept-language') ? req.acceptsLanguages(...LOCALE_IDS) : null;
  return matchLocale(accepted) || DEFAULT_LOCALE;
}

// First-run language for the seeded sample story: CHARBUILD_LANG, else the
// host's locale (LANG / LC_ALL), else English.
export function hostLang() {
  return matchLocale(process.env.CHARBUILD_LANG) || matchLocale(process.env.LC_ALL) || matchLocale(process.env.LANG) || DEFAULT_LOCALE;
}

// Run a synchronous function (e.g. the Markdown export) with the shared data
// and t() in `lang`, then switch straight back. Nothing else can run in
// between, so concurrent requests never see the other language.
export function withLocale(lang, fn) {
  if (lang === DEFAULT_LOCALE) return fn();
  localizeData(lang);
  setLocale(lang);
  try {
    return fn();
  } finally {
    localizeData(DEFAULT_LOCALE);
    setLocale(DEFAULT_LOCALE);
  }
}
