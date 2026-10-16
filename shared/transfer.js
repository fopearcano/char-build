// Export files: the envelope every CharBuild export shares, and file names.
// One shape for everything — a whole library, one story with its cast, a
// selection, or a single character — so any export can be imported back.

export const EXPORT_FORMAT = 2;

export function slugify(text, fallback = 'untitled') {
  const s = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || fallback;
}

// What an export holds: 'library' (everything), 'story' (one story and its
// cast), 'character' (one loose character) or 'selection'.
export function exportKind({ all = false, stories = [], characters = [] }) {
  if (all) return 'library';
  if (stories.length === 1 && characters.every((c) => c.storyId === stories[0].id)) return 'story';
  if (!stories.length && characters.length === 1) return 'character';
  return 'selection';
}

// charbuild-risacca-2026-10-16.json, charbuild-library-…, charbuild-selection-…
export function exportFileName({ kind, stories = [], characters = [] }, ext = 'json', date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  let name = kind === 'library' ? 'library' : 'selection';
  if (kind === 'story' && stories[0]) name = slugify(stories[0].title, 'story');
  if (kind === 'character' && characters[0]) name = slugify(characters[0].name, 'character');
  return `charbuild-${name}-${day}.${ext}`;
}
