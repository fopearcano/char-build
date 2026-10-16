// CharBuild — main controller: state, router, views, autosave, events.

import { SECTIONS, SECTION_BY_ID, PARTS, STORY_FIELDS } from '/shared/sections.js';
import * as K from '/shared/catalog.js';
import { getPath, setPath, displayName, uid } from '/shared/model.js';
import { overallProgress, characterChecks, castChecks, expectedSections, traitDensity, antagonismProfile, choiceDepth, definingDimension } from '/shared/analysis.js';
import { characterMarkdown } from '/shared/export.js';
import { esc, attr, icon, toast, modal, confirmDialog, promptDialog, download, initials, timeAgo, autoGrow, tHtml } from './ui.js';
import { t, tn, getLocale, setLocale, matchLocale, registerLocale, hasLocale, LOCALES, DEFAULT_LOCALE } from '/shared/i18n.js';
import { localizeData, en } from '/shared/i18n-data.js';
import { renderFields, renderStoryFields } from './forms.js';
import * as V from './viz.js';
import { renderCastMap, bindCastMap } from './castmap.js';
import { Assistant } from './assistant.js';
import { createTransfer } from './transfer.js';
import { exportFileName } from '/shared/transfer.js';

const SAMPLE_ID = 'story_undertow';
// The server API level this page needs (see API_LEVEL in server/index.js).
const CLIENT_API = 2;
const LANG_KEY = 'charbuild-lang';

// ── Language ─────────────────────────────────────────────────────────────
// Saved choice, else the browser's languages, else English.
function preferredLocale() {
  try {
    const saved = matchLocale(localStorage.getItem(LANG_KEY));
    if (saved) return saved;
  } catch { /* storage unavailable */ }
  for (const l of navigator.languages || [navigator.language]) {
    const m = matchLocale(l);
    if (m) return m;
  }
  return DEFAULT_LOCALE;
}

// Load the dictionary once, then switch the data (catalog, stations) and
// the interface strings together.
async function applyLocale(id) {
  if (id !== DEFAULT_LOCALE && !hasLocale(id)) {
    const mod = await import(`/shared/locales/${id}.js`);
    registerLocale(id, mod.default);
  }
  localizeData(id);
  setLocale(id);
  document.documentElement.lang = id;
}

const state = {
  stories: [],
  characters: [],
  ai: null,
  route: { view: 'library' },
  saving: 0,
  saveError: false,
};

// ── API ──────────────────────────────────────────────────────────────────
export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-CharBuild-Lang': getLocale(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `${res.status} ${res.statusText}`), { status: res.status, data });
  return data;
}

const charById = (id) => state.characters.find((c) => c.id === id);
const storyById = (id) => state.stories.find((s) => s.id === id);
const castOf = (storyId) => state.characters.filter((c) => (storyId ? c.storyId === storyId : !c.storyId));
const ctxFor = (c) => {
  const story = c.storyId ? storyById(c.storyId) : null;
  return { story, cast: story ? castOf(story.id) : [c] };
};

// ── Saving ───────────────────────────────────────────────────────────────
// Each edit schedules a save of that story or character. Saves of one item
// run one after another, each based on the version the server last returned;
// if another device or tab saved in between, the server refuses (409) and the
// writer chooses which version to keep.
const saveTimers = new Map();
const inflight = new Map();
const conflicted = new Set();
function scheduleSave(kind, id) {
  const key = `${kind}:${id}`;
  clearTimeout(saveTimers.get(key));
  setSaveStatus('pending');
  saveTimers.set(key, setTimeout(() => saveNow(kind, id), 650));
}

function saveNow(kind, id) {
  const key = `${kind}:${id}`;
  clearTimeout(saveTimers.get(key));
  saveTimers.delete(key);
  const prev = inflight.get(key);
  const run = (async () => {
    if (prev) await prev.catch(() => {});
    const entity = kind === 'story' ? storyById(id) : charById(id);
    if (!entity) return;
    state.saving += 1;
    setSaveStatus('saving');
    try {
      const saved = await api('PUT', `/api/${kind === 'story' ? 'stories' : 'characters'}/${id}`, entity);
      entity.updatedAt = saved.updatedAt;
      state.saveError = false;
      conflicted.delete(key);
    } catch (err) {
      if (err.status === 409 && err.data?.current) {
        conflicted.add(key);
        resolveConflict(kind, entity, err.data.current);
      } else {
        state.saveError = true;
        toast(t('Could not save: {error}', { error: err.message }), 'error');
        saveTimers.set(key, setTimeout(() => saveNow(kind, id), 4000));
      }
    } finally {
      state.saving -= 1;
      updateSaveStatus();
    }
  })();
  inflight.set(key, run);
  run.finally(() => {
    if (inflight.get(key) === run) inflight.delete(key);
  });
  return run;
}

function updateSaveStatus() {
  setSaveStatus(conflicted.size ? 'conflict' : state.saveError ? 'error' : saveTimers.size || state.saving ? 'saving' : 'saved');
}

// Another device or tab saved this item after we loaded it.
const resolving = new Set();
async function resolveConflict(kind, local, current) {
  const key = `${kind}:${local.id}`;
  if (resolving.has(key)) return;
  resolving.add(key);
  try {
    await askConflict(kind, local, current);
  } finally {
    resolving.delete(key);
  }
}

async function askConflict(kind, local, current) {
  const name = kind === 'story' ? local.title : displayName(local);
  const choice = await modal({
    title: t('Changed somewhere else'),
    body: `<p>${esc(t('“{name}” was saved from another device or tab while you were editing it here. Which version do you want to keep?', { name }))}</p>
      <p class="help">${esc(t('Theirs was saved {when}.', { when: timeAgo(current.updatedAt) }))}</p>`,
    buttons: [{ label: t('Use the other version'), value: 'theirs' }, { label: t('Keep mine'), value: 'mine', kind: 'primary' }],
  });
  const key = `${kind}:${local.id}`;
  if (choice === 'mine') {
    // Save on top of the newer version (theirs is in the backups).
    const entity = kind === 'story' ? storyById(local.id) : charById(local.id);
    if (entity) entity.updatedAt = current.updatedAt;
    conflicted.delete(key);
    saveNow(kind, local.id);
  } else if (choice === 'theirs') {
    const list = kind === 'story' ? state.stories : state.characters;
    const i = list.findIndex((x) => x.id === local.id);
    if (i >= 0) list[i] = current;
    conflicted.delete(key);
    updateSaveStatus();
    render();
  }
  // Dismissed: nothing is saved until the next edit asks again.
}

async function flushSaves() {
  const keys = [...saveTimers.keys()];
  await Promise.all(keys.map((k) => {
    const [kind, id] = k.split(':');
    return saveNow(kind, id);
  }));
  await Promise.all([...inflight.values()].map((p) => p.catch(() => {})));
}

function setSaveStatus(s) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.dataset.state = s;
  el.textContent = { pending: t('Editing…'), saving: t('Saving…'), saved: t('All changes saved'), error: t('Save failed — retrying'), conflict: t('Not saved — changed elsewhere') }[s] || '';
}

window.addEventListener('beforeunload', (e) => {
  if (saveTimers.size || state.saving) {
    flushSaves();
    e.preventDefault();
  }
});

// ── Router ───────────────────────────────────────────────────────────────
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'story' && parts[1]) return { view: 'story', id: parts[1] };
  if (parts[0] === 'char' && parts[1]) {
    if (parts[2] === 'profile') return { view: 'profile', id: parts[1] };
    return { view: 'builder', id: parts[1], section: SECTION_BY_ID[parts[2]] ? parts[2] : 'spark' };
  }
  return { view: 'library' };
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  await flushSaves();
  state.route = parseRoute();
  render();
  window.scrollTo(0, 0);
}

// ── Rendering ────────────────────────────────────────────────────────────
const app = document.getElementById('app');

function render() {
  const r = state.route;
  let body;
  if (r.view === 'story') body = storyById(r.id) ? storyView(storyById(r.id)) : notFound();
  else if (r.view === 'builder') body = charById(r.id) ? builderView(charById(r.id), r.section) : notFound();
  else if (r.view === 'profile') body = charById(r.id) ? profileView(charById(r.id)) : notFound();
  else body = libraryView();
  app.innerHTML = topbar() + body;
  app.querySelectorAll('textarea.inp').forEach(autoGrow);
  if (r.view === 'story' && storyById(r.id)) mountCastMap(storyById(r.id));
  assistant.setContext(currentContext());
  document.title = titleFor(r);
}

function titleFor(r) {
  if (r.view === 'builder' && charById(r.id)) return `${displayName(charById(r.id))} · ${SECTION_BY_ID[r.section].title} — CharBuild`;
  if (r.view === 'profile' && charById(r.id)) return `${displayName(charById(r.id))} · ${t('Profile')} — CharBuild`;
  if (r.view === 'story' && storyById(r.id)) return `${storyById(r.id).title} — CharBuild`;
  return t('CharBuild — character builder after McKee');
}

function currentContext() {
  const r = state.route;
  const c = ['builder', 'profile'].includes(r.view) ? charById(r.id) : null;
  return { character: c, section: r.view === 'builder' ? r.section : null, story: c ? ctxFor(c).story : r.view === 'story' ? storyById(r.id) : null };
}

function notFound() {
  return `<main class="page narrow"><div class="card empty-state"><h1>${esc(t('Not found'))}</h1><p>${esc(t('That story or character doesn’t exist (any more).'))}</p><a class="btn primary" href="#/">${icon('home')} ${esc(t('Back to library'))}</a></div></main>`;
}

function topbar() {
  const r = state.route;
  const c = ['builder', 'profile'].includes(r.view) ? charById(r.id) : null;
  const story = c ? ctxFor(c).story : r.view === 'story' ? storyById(r.id) : null;
  const crumbs = [`<a href="#/" class="crumb">${icon('home')}<span>${esc(t('Library'))}</span></a>`];
  if (story) crumbs.push(`<a href="#/story/${attr(story.id)}" class="crumb">${icon('map')}<span>${esc(story.title)}</span></a>`);
  if (c) crumbs.push(`<a href="#/char/${attr(c.id)}/${r.view === 'builder' ? r.section : 'spark'}" class="crumb"><span class="dot" style="background:${esc(c.color)}"></span><span>${esc(displayName(c))}</span></a>`);
  const aiOn = state.ai?.configured;
  return `<header class="topbar">
    <a class="brand" href="#/" aria-label="${attr(t('CharBuild home'))}"><span class="logo">${logoSvg()}</span><span class="brand-t"><b>CharBuild</b><small>${tHtml('after McKee’s {book}', { book: '<i>Character</i>' })}</small></span></a>
    <nav class="crumbs" aria-label="Breadcrumb">${crumbs.join(`<span class="sep">${icon('chevron')}</span>`)}</nav>
    <div class="top-actions">
      <span id="save-status" class="save-status" data-state="saved" aria-live="polite"></span>
      ${c ? `<a class="btn ghost sm ${r.view === 'profile' ? 'active' : ''}" href="#/char/${attr(c.id)}/profile">${icon('chart')}<span>${esc(t('Profile'))}</span></a>` : ''}
      <button class="btn sm coach-btn ${aiOn ? 'on' : ''}" data-action="toggle-assistant" title="${attr(t('AI coach (optional)'))}">${icon('sparkle')}<span>${esc(t('Coach'))}</span></button>
      <button class="icon-btn" data-action="toggle-theme" aria-label="${attr(t('Toggle dark mode'))}" title="${attr(t('Toggle dark mode'))}">${icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')}</button>
      ${langMenu()}
    </div>
  </header>`;
}

// Top-right language switcher: a button that opens a small menu.
function langMenu() {
  const cur = LOCALES.find((l) => l.id === getLocale()) || LOCALES[0];
  return `<div class="lang-menu">
    <button class="btn ghost sm lang-btn" data-action="toggle-lang" aria-haspopup="menu" aria-expanded="false" aria-controls="lang-pop" title="${attr(t('Language'))}" aria-label="${attr(t('Language: {name}', { name: cur.label }))}">${icon('globe')}<span>${esc(cur.short)}</span>${icon('chevronDown', 'caret')}</button>
    <div class="lang-pop" id="lang-pop" role="menu" hidden>${LOCALES.map((l) => `<button role="menuitemradio" aria-checked="${l.id === cur.id}" class="lang-opt ${l.id === cur.id ? 'on' : ''}" data-action="set-lang" data-lang="${attr(l.id)}" lang="${attr(l.id)}"><span class="lang-code">${esc(l.short)}</span><span>${esc(l.label)}</span>${l.id === cur.id ? icon('check') : ''}</button>`).join('')}</div>
  </div>`;
}

function setLangMenu(open) {
  const pop = document.getElementById('lang-pop');
  const btn = document.querySelector('.lang-btn');
  if (!pop || !btn) return;
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) (pop.querySelector('.lang-opt.on') || pop.querySelector('.lang-opt'))?.focus();
}

function logoSvg() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="2.2" opacity=".35"/><circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" stroke-width="2.2" opacity=".65"/><path d="M16 2v28" stroke="currentColor" stroke-width="2.2"/><circle cx="16" cy="16" r="4" fill="currentColor"/></svg>`;
}

// ── Library ──────────────────────────────────────────────────────────────
function libraryView() {
  const storyCards = state.stories.map((s) => {
    const cast = castOf(s.id);
    const genres = (s.genre?.primary || []).map((id) => K.PRIMARY_GENRES.find((g) => g.id === id)).filter(Boolean);
    const prot = cast.find((c) => c.cast?.circle === 'protagonist');
    return `<article class="story-card card">
      <a class="sc-main" href="#/story/${attr(s.id)}">
        <div class="sc-head"><h2>${esc(s.title)}</h2>${s.format ? `<span class="tag">${esc(s.format)}</span>` : ''}</div>
        ${s.logline ? `<p class="logline">${esc(s.logline)}</p>` : `<p class="logline muted">${esc(t('No logline yet.'))}</p>`}
        <div class="gchips">${genres.map((g) => `<span class="gchip ${g.family}">${esc(g.label)}</span>`).join('')}</div>
      </a>
      <div class="sc-cast">${cast.map((c) => `<a class="avatar sm" style="--c:${esc(c.color)}" href="#/char/${attr(c.id)}/spark" title="${attr(displayName(c))}">${esc(initials(displayName(c)))}</a>`).join('')}
        <button class="avatar sm add" data-action="new-char" data-story="${attr(s.id)}" title="${attr(t('New character'))}" aria-label="${attr(t('New character'))}">${icon('plus')}</button></div>
      <footer class="sc-foot"><span>${esc(tn(cast.length, '{n} character', '{n} characters'))}${prot ? ` · ${esc(t('lead: {name}', { name: displayName(prot) }))}` : ''}</span><span class="sc-end"><span class="muted">${esc(timeAgo(s.updatedAt))}</span><button class="icon-btn sm" data-action="export-dialog" data-story="${attr(s.id)}" title="${attr(t('Export this story'))}" aria-label="${attr(t('Export this story'))}">${icon('download')}</button></span></footer>
    </article>`;
  }).join('');
  const loose = castOf(null);
  return `<main class="page library">
    <section class="hero">
      <div class="hero-text">
        <p class="eyebrow">${esc(t('Character builder'))}</p>
        <h1>${esc(t('Design characters from the outside in — and the inside out.'))}</h1>
        <p class="lede">${tHtml('Sixteen stations that walk Robert McKee’s {book}: characterization and true character, the four selves, dimensions, antagonism, arc and cast design — every choice visualized as you make it, with an optional AI coach grounded in the book.', { book: '<i>CHARACTER</i>' })}</p>
        <div class="hero-actions">
          <button class="btn primary" data-action="new-story">${icon('plus')} ${esc(t('New story'))}</button>
          <button class="btn" data-action="import">${icon('upload')} ${esc(t('Import'))}</button>
          <button class="btn ghost" data-action="export-dialog">${icon('download')} ${esc(t('Export…'))}</button>
          <button class="btn ghost" data-action="backups">${icon('refresh')} ${esc(t('Backups'))}</button>
          ${sampleButton()}
        </div>
      </div>
      <div class="hero-map">${methodMap()}</div>
    </section>
    <h2 class="section-title">${esc(t('Stories'))}</h2>
    <div class="story-grid-lib">${storyCards || `<div class="card empty-state"><p>${esc(t('No stories yet.'))}</p><button class="btn primary" data-action="new-story">${icon('plus')} ${esc(t('Create your first story'))}</button></div>`}</div>
    ${loose.length ? `<h2 class="section-title">${esc(t('Characters without a story'))}</h2><div class="char-cards">${loose.map(charCard).join('')}</div>` : ''}
    <footer class="credits">${tHtml('Framework after Robert McKee, {book} ({year}). Guidance is paraphrased with chapter references; book search uses your own copy in {docs}.', { book: `<i>${esc(K.BOOK.title)}</i>`, year: K.BOOK.year, docs: '<code>docs/</code>' })}
      ${state.server ? `<span class="app-version">CharBuild ${esc(t('Version {version}', { version: state.server.version }))}${state.server.commit ? ` · <code>${esc(state.server.commit)}</code>` : ''}</span>` : ''}</footer>
  </main>`;
}

// The sample story exists in every interface language; offer to restore it,
// or to swap it for the version in the current language.
function sampleButton() {
  const sample = storyById(SAMPLE_ID);
  if (!sample) return `<button class="btn ghost" data-action="restore-sample">${icon('refresh')} ${esc(t('Restore sample'))}</button>`;
  if ((sample.sampleLang || DEFAULT_LOCALE) === getLocale()) return '';
  const lang = LOCALES.find((l) => l.id === getLocale());
  return `<button class="btn ghost" data-action="translate-sample">${icon('globe')} ${esc(t('Sample story in {language}', { language: lang?.label || getLocale() }))}</button>`;
}

function methodMap() {
  return `<div class="method">${PARTS.map((p) => `<div class="m-part"><h4>${esc(p.title)}</h4><ul>${SECTIONS.filter((s) => s.part === p.id).map((s) => `<li class="acc-${s.accent}"><span>${s.num}</span>${esc(s.title)}</li>`).join('')}</ul></div>`).join('')}</div>`;
}

function charCard(c) {
  const ctx = ctxFor(c);
  const p = overallProgress(c, ctx.story);
  const circle = K.CIRCLES.find((x) => x.id === c.cast?.circle);
  const def = definingDimension(c);
  return `<article class="char-card card" style="--c:${esc(c.color)}">
    <a href="#/char/${attr(c.id)}/spark" class="cc-main">
      <span class="avatar">${esc(initials(displayName(c)))}</span>
      <div class="cc-text"><h3>${esc(displayName(c))}</h3><p>${esc(circle?.label || t('Unplaced'))}${c.concept?.roleLabel ? ` · ${esc(c.concept.roleLabel)}` : ''}</p>
      ${def ? `<p class="cc-dim"><b>${esc(def.positive)}</b> / <b>${esc(def.negative)}</b></p>` : ''}</div>
      ${V.progressRing(p.ratio, 46, 5, 'var(--c)')}
    </a>
    <div class="cc-stats"><span title="${attr(t('Dimensions'))}">${esc(t('{n} dim', { n: (c.dimensions || []).length }))}</span><span title="${attr(t('Known traits'))}">${esc(t('{n} traits', { n: traitDensity(c).known }))}</span><a href="#/char/${attr(c.id)}/profile">${icon('chart')} ${esc(t('profile'))}</a></div>
  </article>`;
}

// ── Story view ───────────────────────────────────────────────────────────
function storyView(s) {
  const cast = castOf(s.id);
  const checks = castChecks(s, cast);
  const genres = (s.genre?.primary || []).map((id) => K.PRIMARY_GENRES.find((g) => g.id === id)).filter(Boolean);
  const order = { protagonist: 0, first: 1, second: 2, third: 3 };
  const sorted = [...cast].sort((a, b) => (order[a.cast?.circle] ?? 4) - (order[b.cast?.circle] ?? 4));
  return `<main class="page story-page" data-entity="story" data-id="${attr(s.id)}">
    <section class="story-hero card">
      <div><p class="eyebrow">${esc(t('Story'))}</p><h1>${esc(s.title)}</h1>${s.logline ? `<p class="logline">${esc(s.logline)}</p>` : ''}
      <div class="gchips">${genres.map((g) => `<span class="gchip ${g.family}" title="${attr(g.coreValue)}">${esc(g.label)}</span>`).join('')}${s.coreValue?.positive ? `<span class="tag">${esc(s.coreValue.positive)} ↔ ${esc(s.coreValue.negative || '?')}</span>` : ''}</div></div>
      <div class="hero-actions">
        <button class="btn primary" data-action="new-char" data-story="${attr(s.id)}">${icon('plus')} ${esc(t('New character'))}</button>
        <button class="btn ghost" data-action="export-dialog" data-story="${attr(s.id)}">${icon('download')} ${esc(t('Export'))}</button>
        <button class="btn ghost" data-action="delete-story" data-id="${attr(s.id)}">${icon('trash')} ${esc(t('Delete story'))}</button>
      </div>
    </section>
    <div class="story-layout">
      <section class="card castmap-card"><div class="card-head"><h2>${esc(t('Cast map'))}</h2><span class="muted">${esc(t('Drag characters between orbits · click to open · Ch. 6, 17'))}</span></div>
        <div id="castmap">${renderCastMap(s, cast)}</div></section>
      <aside class="story-side">
        <section class="card"><div class="card-head"><h2>${esc(t('Cast design checks'))}</h2></div>${checksList(checks, { empty: t('No cast-level issues found.') })}</section>
        ${genres.map((g) => `<section class="card genre-mini"><h3>${esc(g.label)}</h3><p class="gv">${esc(g.coreValue)}</p><p class="muted">${esc(g.coreEvent)} · ${esc(g.coreEmotion)}</p><p class="cast-roles">${g.coreCast.map((r) => {
    const who = cast.filter((c) => c.genre?.coreCastRole === r).map(displayName);
    return `<span class="cc ${who.length ? 'on' : ''}">${esc(t(r))}${who.length ? `: ${esc(who.join(', '))}` : ''}</span>`;
  }).join('')}</p></section>`).join('')}
      </aside>
    </div>
    <h2 class="section-title">${esc(t('Cast'))}</h2>
    <div class="char-cards">${sorted.map(charCard).join('')}<button class="char-card card add-card" data-action="new-char" data-story="${attr(s.id)}">${icon('plus')}<span>${esc(t('New character'))}</span></button></div>
    <h2 class="section-title">${esc(t('Story settings'))}</h2>
    <section class="card story-settings"><div class="fields grid2">${renderStoryFields(STORY_FIELDS, s)}</div></section>
  </main>`;
}

function mountCastMap(story) {
  const root = document.getElementById('castmap');
  if (!root) return;
  bindCastMap(root, {
    onMove: (id, circle, angle) => {
      const c = charById(id);
      if (!c) return;
      c.cast.circle = circle;
      c.cast.mapAngle = angle;
      scheduleSave('char', id);
      render();
    },
    onOpen: (id) => go(`#/char/${id}/spark`),
  });
}

// ── Builder ──────────────────────────────────────────────────────────────
function builderView(c, sectionId) {
  const section = SECTION_BY_ID[sectionId];
  const ctx = ctxFor(c);
  const idx = SECTIONS.indexOf(section);
  const prev = SECTIONS[idx - 1];
  const next = SECTIONS[idx + 1];
  const part = PARTS.find((p) => p.id === section.part);
  const expected = expectedSections(c).includes(section.id);
  return `<div class="builder" data-entity="char" data-id="${attr(c.id)}">
    <aside class="nav" id="nav">${navHtml(c, sectionId)}</aside>
    <main class="station acc-${section.accent}" id="station">
      <header class="station-head">
        <div class="big-num" aria-hidden="true">${section.num}</div>
        <div class="sh-text"><p class="eyebrow">${esc(part.title)} · ${esc(part.subtitle)}</p><h1>${esc(section.title)}</h1><p class="sub">${esc(section.subtitle)}</p>
        <div class="chapters">${section.chapters.map((n) => `<span class="ch">${esc(t('Ch. {n}', { n }))} · ${esc(K.CHAPTERS[n])}</span>`).join('')}</div>
        ${expected ? '' : `<p class="optional-note">${icon('info')} ${esc(t('Optional for a {circle} role — McKee keeps outer-circle roles lean.', { circle: K.CIRCLES.find((x) => x.id === c.cast?.circle)?.label.toLowerCase() || t('minor') }))}</p>`}</div>
      </header>
      <section class="principle card">
        <div class="pr-text"><h3>${icon('book')} ${esc(t('McKee’s principle'))}</h3><p>${esc(section.principle)}</p></div>
        <div class="pr-q"><h4>${esc(t('Ask yourself'))}</h4><ul>${section.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>
        <div class="pr-actions"><button class="btn sm" data-action="ask" data-prompt="brainstorm">${icon('sparkle')} ${esc(t('Brainstorm with coach'))}</button><button class="btn ghost sm" data-action="ask" data-prompt="critique">${esc(t('Critique this station'))}</button><button class="btn ghost sm" data-action="book-search" data-q="${attr(en(section, 'title'))}" title="${attr(t('Search the original English text'))}">${icon('search')} ${esc(t('In the book'))}</button></div></div>
      </section>
      ${section.groups.filter((g) => !g.showIf || g.showIf(c, ctx.story)).map((g) => `<section class="group card"><div class="group-head"><h2>${esc(g.title)}</h2>${g.hint ? `<p class="hint">${esc(g.hint)}</p>` : ''}</div><div class="fields">${renderFields(g.fields, c, ctx)}</div></section>`).join('')}
      <nav class="pager">${prev ? `<a class="btn ghost" href="#/char/${attr(c.id)}/${prev.id}">← ${prev.num} ${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="btn primary" href="#/char/${attr(c.id)}/${next.id}">${next.num} ${esc(next.title)} →</a>` : `<a class="btn primary" href="#/char/${attr(c.id)}/profile">${icon('chart')} ${esc(t('See the profile →'))}</a>`}</nav>
    </main>
    <aside class="rail acc-${section.accent}" id="rail" aria-label="${attr(t('Live visualization'))}">${railHtml(c, section)}</aside>
  </div>`;
}

function navHtml(c, sectionId) {
  const ctx = ctxFor(c);
  const p = overallProgress(c, ctx.story);
  const circle = K.CIRCLES.find((x) => x.id === c.cast?.circle);
  return `<div class="char-head" style="--c:${esc(c.color)}">
      <button class="avatar lg" data-action="pick-color" title="${attr(t('Change colour'))}">${esc(initials(displayName(c)))}</button>
      <div class="ch-text"><b>${esc(displayName(c))}</b><span>${esc(circle?.label || t('Unplaced'))}</span></div>
      <div class="ch-ring">${V.progressRing(p.ratio, 44, 5, 'var(--c)')}</div>
    </div>
    <div class="nav-tools">
      <a class="btn ghost sm" href="#/char/${attr(c.id)}/profile">${icon('chart')} ${esc(t('Profile'))}</a>
      <button class="btn ghost sm" data-action="char-menu">${icon('menu')} ${esc(t('More'))}</button>
    </div>
    <label class="nav-select"><span class="sr-only">${esc(t('Station'))}</span><select data-action="nav-select">${SECTIONS.map((s) => `<option value="${s.id}" ${s.id === sectionId ? 'selected' : ''}>${s.num} ${esc(s.title)}</option>`).join('')}</select></label>
    <div class="nav-parts">${PARTS.map((pt) => `<div class="nav-part"><h4>${esc(pt.title)}</h4>${SECTIONS.filter((s) => s.part === pt.id).map((s) => {
    const b = p.bySection[s.id];
    return `<a class="nav-item acc-${s.accent} ${s.id === sectionId ? 'active' : ''} ${b.expected ? '' : 'optional'}" href="#/char/${attr(c.id)}/${s.id}" ${s.id === sectionId ? 'aria-current="page"' : ''}>
        <span class="num">${s.num}</span><span class="t">${esc(s.title)}</span><span class="mini"><i style="width:${Math.round(b.ratio * 100)}%"></i></span></a>`;
  }).join('')}</div>`).join('')}</div>`;
}

function railHtml(c, section) {
  const ctx = ctxFor(c);
  const fn = V.VISUALS[section.visual];
  const checks = characterChecks(c, ctx.story, ctx.cast);
  const mine = checks.filter((x) => x.section === section.id);
  const elsewhere = checks.filter((x) => x.section !== section.id && x.level === 'warn').length;
  return `<div id="rail-visual">${fn ? fn(c, ctx) : ''}</div>
    <div id="rail-checks" class="viz-card"><div class="viz-head"><h3>${esc(t('McKee checks'))}</h3><span class="viz-sub">${esc(t('this station'))}</span></div>
      ${checksList(mine, { empty: t('Nothing flagged here yet.') })}
      ${elsewhere ? `<a class="more-checks" href="#/char/${attr(c.id)}/profile">${esc(tn(elsewhere, '{n} warning in other stations →', '{n} warnings in other stations →'))}</a>` : ''}</div>`;
}

function checksList(checks, { empty = '' } = {}) {
  if (!checks.length) return `<p class="viz-empty">${esc(empty)}</p>`;
  const order = { warn: 0, tip: 1, good: 2 };
  return `<ul class="checks">${[...checks].sort((a, b) => order[a.level] - order[b.level]).map((x) => `<li class="chk ${x.level}">
    <span class="chk-ic">${icon(x.level === 'warn' ? 'alert' : x.level === 'good' ? 'check' : 'info')}</span>
    <div><b>${esc(x.title)}</b><p>${esc(x.detail)}</p><span class="ref">${esc(x.ref)}</span></div></li>`).join('')}</ul>`;
}

// Re-render the non-input parts after edits (keeps focus in the form).
let liveQueued = false;
function refreshLive() {
  if (liveQueued) return;
  liveQueued = true;
  requestAnimationFrame(() => {
    liveQueued = false;
    const r = state.route;
    if (r.view !== 'builder') return;
    const c = charById(r.id);
    if (!c) return;
    const rail = document.getElementById('rail');
    if (rail && !dragState) rail.innerHTML = railHtml(c, SECTION_BY_ID[r.section]);
    const nav = document.getElementById('nav');
    if (nav) {
      const scroll = nav.querySelector('.nav-parts')?.scrollTop;
      nav.innerHTML = navHtml(c, r.section);
      if (scroll) nav.querySelector('.nav-parts').scrollTop = scroll;
    }
  });
}

function rerenderStation() {
  const r = state.route;
  if (r.view !== 'builder') return render();
  const c = charById(r.id);
  const main = document.getElementById('station');
  if (!main || !c) return render();
  const active = document.activeElement;
  const activeKey = active?.dataset ? `${active.dataset.path || ''}|${active.dataset.list || ''}|${active.dataset.index || ''}|${active.dataset.field || ''}|${active.dataset.value || ''}|${active.dataset.toggle || ''}` : null;
  const tmp = document.createElement('div');
  tmp.innerHTML = builderView(c, r.section);
  main.replaceWith(tmp.querySelector('#station'));
  document.querySelectorAll('#station textarea.inp').forEach(autoGrow);
  if (activeKey) {
    const el = [...document.querySelectorAll('#station [data-path], #station [data-list]')].find((e) => `${e.dataset.path || ''}|${e.dataset.list || ''}|${e.dataset.index || ''}|${e.dataset.field || ''}|${e.dataset.value || ''}|${e.dataset.toggle || ''}` === activeKey);
    el?.focus({ preventScroll: true });
  }
  refreshLive();
}

// ── Profile ──────────────────────────────────────────────────────────────
function profileView(c) {
  const ctx = ctxFor(c);
  const p = overallProgress(c, ctx.story);
  const td = traitDensity(c);
  const ap = antagonismProfile(c);
  const cd = choiceDepth(c);
  const def = definingDimension(c);
  const circle = K.CIRCLES.find((x) => x.id === c.cast?.circle);
  const checks = characterChecks(c, ctx.story, ctx.cast);
  const stat = (label, value, sub = '') => `<div class="stat"><b>${value}</b><span>${esc(label)}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  return `<main class="page profile" style="--c:${esc(c.color)}">
    <header class="pf-hero card">
      <div class="pf-id"><span class="avatar xl">${esc(initials(displayName(c)))}</span>
        <div><p class="eyebrow">${esc(circle?.label || t('Unplaced'))}${c.concept?.roleLabel ? ` · ${esc(c.concept.roleLabel)}` : ''}${ctx.story ? ` · ${esc(ctx.story.title)}` : ''}</p>
        <h1>${esc(displayName(c))}</h1>${c.concept?.nickname ? `<p class="nick">“${esc(c.concept.nickname)}”</p>` : ''}
        ${c.concept?.logline ? `<p class="logline">${esc(c.concept.logline)}</p>` : ''}</div></div>
      <div class="pf-stats">
        <div class="stat ring">${V.progressRing(p.ratio, 64, 7, 'var(--c)')}<span>${esc(t('built'))}</span></div>
        ${stat(t('dimensions'), (c.dimensions || []).length, def ? `${esc(def.positive)} / ${esc(def.negative)}` : '')}
        ${stat(t('traits on page'), `${td.expressed}/${td.known}`, td.known ? esc(t('{pct}% · ideal ≈30%', { pct: Math.round(td.expressedRatio * 100) })) : '')}
        ${stat(t('underdog'), ap.capacity == null ? '—' : esc(ap.underdog ? t('Yes') : t('No')), ap.capacity == null ? '' : esc(t('{power} vs {capacity}', { power: ap.power, capacity: ap.capacity })))}
        ${stat(t('choice depth'), cd ?? '—', cd != null ? '/10' : '')}
      </div>
      <div class="pf-actions">
        <a class="btn" href="#/char/${attr(c.id)}/spark">${icon('user')} ${esc(t('Open builder'))}</a>
        <button class="btn ghost" data-action="export-md">${icon('file')} Markdown</button>
        <button class="btn ghost" data-action="export-json">${icon('download')} JSON</button>
        <button class="btn ghost" data-action="print">${icon('print')} ${esc(t('Print'))}</button>
      </div>
    </header>
    <section class="card pf-stations"><div class="card-head"><h2>${esc(t('Sixteen stations'))}</h2><span class="muted">${esc(t('click a bar to open it'))}</span></div>${V.stationBars(c, ctx.story)}</section>
    <div class="pf-grid">
      ${V.dimensionWheel(c, { interactive: false })}
      ${V.fourSelves(c, { compact: true })}
      ${V.bigFive(c)}
      ${V.motivationLadder(c)}
      ${V.underdogScale(c)}
      ${V.arcChart(c, { interactive: false })}
      ${V.VISUALS.choiceDepth(c)}
      ${V.traitDensity(c)}
      ${V.symbolicSpectrum(c)}
      ${V.performanceStar(c)}
      ${V.relationshipWeb(c, ctx)}
      <div class="viz-card pf-checks"><div class="viz-head"><h3>${esc(t('McKee checks'))}</h3><span class="viz-sub">${esc(tn(checks.filter((x) => x.level === 'warn').length, '{n} warning', '{n} warnings'))} · ${esc(tn(checks.filter((x) => x.level === 'tip').length, '{n} tip', '{n} tips'))}</span></div>${checksList(checks, { empty: t('No issues found.') })}</div>
    </div>
  </main>`;
}

// ── Mutations ────────────────────────────────────────────────────────────
function entityFor(el) {
  const host = el.closest('[data-entity]');
  if (!host) return null;
  return host.dataset.entity === 'story' ? { kind: 'story', obj: storyById(host.dataset.id) } : { kind: 'char', obj: charById(host.dataset.id) };
}

function changed(ent, { rerender = false } = {}) {
  scheduleSave(ent.kind, ent.obj.id);
  if (ent.kind === 'story') {
    if (rerender) render();
    return;
  }
  if (rerender) rerenderStation();
  else refreshLive();
}

const LIST_TEMPLATES = {
  dimensions: () => ({ id: uid('dim'), positive: '', negative: '', type: '', level: '', defining: false }),
  'selves.personae': () => ({ id: uid('p'), with: '', axis: '', persona: '' }),
  'arc.turningPoints': () => ({ id: uid('tp'), label: '', charge: 0 }),
  'action.scenes': () => ({ id: uid('sc'), title: '', from: null, to: null }),
  relationships: () => ({ id: uid('rel'), targetId: '', kind: '', effect: '', draws: '', dimensionId: '' }),
};

function listOf(obj, path) {
  let list = getPath(obj, path);
  if (!Array.isArray(list)) {
    list = [];
    setPath(obj, path, list);
  }
  return list;
}

// ── Events ───────────────────────────────────────────────────────────────
app.addEventListener('input', (e) => {
  const el = e.target;
  if (el.matches('textarea')) autoGrow(el);
  const ent = entityFor(el);
  if (!ent?.obj) return;
  if (el.dataset.path && !el.dataset.toggle && el.type !== 'checkbox') {
    const value = el.dataset.num !== undefined ? Number(el.value) : el.value;
    if (el.type === 'range') syncRange(el);
    setPath(ent.obj, el.dataset.path, value);
    if (el.dataset.path === 'name') updateNameEverywhere(ent.obj);
    changed(ent);
  } else if (el.dataset.list && el.type !== 'checkbox' && el.tagName !== 'SELECT') {
    const list = listOf(ent.obj, el.dataset.list);
    const item = list[Number(el.dataset.index)];
    if (!item) return;
    item[el.dataset.field] = el.dataset.num !== undefined ? Number(el.value) : el.value;
    if (el.type === 'range') syncRange(el);
    changed(ent);
  }
});

function syncRange(el) {
  const min = Number(el.min);
  const max = Number(el.max);
  el.style.setProperty('--p', `${((Number(el.value) - min) / (max - min)) * 100}%`);
  const wrap = el.closest('.slider');
  if (wrap) {
    wrap.classList.remove('unset');
    const out = wrap.querySelector('output');
    if (out) out.textContent = el.value;
  }
}

function updateNameEverywhere(c) {
  document.querySelectorAll('.char-head .ch-text b').forEach((b) => { b.textContent = displayName(c); });
}

app.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.action === 'nav-select') return go(`#/char/${state.route.id}/${el.value}`);
  const ent = entityFor(el);
  if (!ent?.obj) return;
  if (el.type === 'checkbox' && el.dataset.toggle && el.dataset.path) {
    const arr = [...(getPath(ent.obj, el.dataset.path) || [])];
    const i = arr.indexOf(el.dataset.toggle);
    if (el.checked && i < 0) arr.push(el.dataset.toggle);
    if (!el.checked && i >= 0) arr.splice(i, 1);
    setPath(ent.obj, el.dataset.path, arr);
    el.closest('.check')?.classList.toggle('on', el.checked);
    return changed(ent);
  }
  if (el.type === 'checkbox' && el.dataset.bool !== undefined) {
    if (el.dataset.list) {
      const item = listOf(ent.obj, el.dataset.list)[Number(el.dataset.index)];
      if (item) item[el.dataset.field] = el.checked;
    } else setPath(ent.obj, el.dataset.path, el.checked);
    return changed(ent);
  }
  if (el.tagName === 'SELECT') {
    if (el.dataset.list) {
      const item = listOf(ent.obj, el.dataset.list)[Number(el.dataset.index)];
      if (item) item[el.dataset.field] = el.value;
      return changed(ent, { rerender: el.dataset.field === 'targetId' });
    }
    setPath(ent.obj, el.dataset.path, el.value);
    return changed(ent, { rerender: true });
  }
  if (el.type === 'range' && el.dataset.path && ['inner.motivations.more', 'symbolic.spectrum'].includes(el.dataset.path)) {
    return changed(ent, { rerender: true });
  }
});

app.addEventListener('click', async (e) => {
  const el = e.target.closest('button, a, [data-action], g[data-action]');
  if (!el) return;
  const ent = entityFor(el);

  // Single-choice cards & segments
  if (el.dataset.value !== undefined && el.dataset.path && ent?.obj) {
    const cur = getPath(ent.obj, el.dataset.path);
    setPath(ent.obj, el.dataset.path, cur === el.dataset.value ? '' : el.dataset.value);
    return changed(ent, { rerender: true });
  }
  // Multi-select chips
  if (el.tagName === 'BUTTON' && el.dataset.toggle && el.dataset.path && ent?.obj) {
    const arr = [...(getPath(ent.obj, el.dataset.path) || [])];
    const i = arr.indexOf(el.dataset.toggle);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(el.dataset.toggle);
    setPath(ent.obj, el.dataset.path, arr);
    return changed(ent, { rerender: true });
  }
  const action = el.dataset.action;
  if (!action) return;
  const handler = ACTIONS[action];
  if (handler) {
    e.preventDefault();
    try {
      await handler(el, ent);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

// Close the language menu on outside click or Escape.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.lang-menu')) setLangMenu(false);
});
document.addEventListener('keydown', (e) => {
  const pop = document.getElementById('lang-pop');
  if (!pop || pop.hidden) return;
  if (e.key === 'Escape') {
    setLangMenu(false);
    document.querySelector('.lang-btn')?.focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const opts = [...pop.querySelectorAll('.lang-opt')];
    const i = opts.indexOf(document.activeElement);
    opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length]?.focus();
  }
});

app.addEventListener('keydown', (e) => {
  const g = e.target.closest('g[data-action]');
  if (g && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
});

const ACTIONS = {
  'toggle-theme': () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('charbuild-theme', next); } catch { /* storage unavailable */ }
    render();
  },
  'toggle-assistant': () => assistant.toggle(),
  ask: (el) => {
    const ctx = currentContext();
    if (!ctx.character) return;
    const s = SECTION_BY_ID[ctx.section];
    const prompts = {
      brainstorm: t('Let’s work on station {num} “{title}”. Look at what I have, ask me what you need, and propose concrete options for the empty or weak fields.', { num: s.num, title: s.title }),
      critique: t('Critique station {num} “{title}” for this character with McKee’s principles. What’s clichéd, missing or contradictory? Keep it to the three most important points, then propose fixes.', { num: s.num, title: s.title }),
    };
    assistant.ask(prompts[el.dataset.prompt] || el.dataset.prompt);
  },
  'book-search': (el) => assistant.openBook(el.dataset.q),
  'toggle-expressed': (el, ent) => {
    const key = el.dataset.key;
    ent.obj.outer.expressed = ent.obj.outer.expressed || {};
    ent.obj.outer.expressed[key] = !ent.obj.outer.expressed[key];
    if (!ent.obj.outer.expressed[key]) delete ent.obj.outer.expressed[key];
    changed(ent, { rerender: true });
  },
  clear: (el, ent) => {
    setPath(ent.obj, el.dataset.path, null);
    changed(ent, { rerender: true });
  },
  'add-item': (el, ent) => {
    const list = listOf(ent.obj, el.dataset.list);
    list.push((LIST_TEMPLATES[el.dataset.list] || (() => ({ id: uid('it') })))());
    changed(ent, { rerender: true });
    focusLastItem(el.dataset.list);
  },
  'add-dimension': (el, ent) => {
    const list = listOf(ent.obj, 'dimensions');
    list.push({ ...LIST_TEMPLATES.dimensions(), positive: el.dataset.pos, negative: el.dataset.neg, defining: !list.some((d) => d.defining) && list.length === 0 });
    changed(ent, { rerender: true });
  },
  'remove-item': async (el, ent) => {
    const list = listOf(ent.obj, el.dataset.list);
    const i = Number(el.dataset.index);
    const [removed] = list.splice(i, 1);
    if (el.dataset.list === 'dimensions' && removed) {
      if (ent.obj.arc?.dimensionId === removed.id) ent.obj.arc.dimensionId = '';
      for (const r of ent.obj.relationships || []) if (r.dimensionId === removed.id) r.dimensionId = '';
    }
    changed(ent, { rerender: true });
    toast(t('Removed'), 'info', 1500);
  },
  'move-item': (el, ent) => {
    const list = listOf(ent.obj, el.dataset.list);
    const i = Number(el.dataset.index);
    const j = i + Number(el.dataset.dir);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    changed(ent, { rerender: true });
  },
  'set-defining': (el, ent) => {
    const i = Number(el.dataset.index);
    const dims = ent.obj.dimensions || [];
    const turnOn = !dims[i].defining;
    dims.forEach((d, k) => { d.defining = turnOn && k === i; });
    changed(ent, { rerender: true });
  },
  'focus-dim': (el) => {
    const c = charById(state.route.id);
    if (!c) return;
    const target = () => {
      const card = document.getElementById(`dim-${el.dataset.id}`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('flash');
        setTimeout(() => card.classList.remove('flash'), 1200);
      }
    };
    if (state.route.section !== 'dimensions') {
      go(`#/char/${c.id}/dimensions`);
      setTimeout(target, 80);
    } else target();
  },
  'open-char': (el) => go(`#/char/${el.dataset.id}/${state.route.view === 'builder' ? state.route.section : 'spark'}`),
  'new-story': async () => {
    const title = await promptDialog(t('New story'), t('Working title'), '');
    if (title == null) return;
    const s = await api('POST', '/api/stories', { title: title.trim() || t('Untitled story') });
    state.stories.push(s);
    go(`#/story/${s.id}`);
  },
  'new-char': async (el) => {
    const name = await promptDialog(t('New character'), t('Name (you can change it later)'), '');
    if (name == null) return;
    const storyId = el.dataset.story || null;
    const cast = castOf(storyId);
    const c = await api('POST', '/api/characters', { name: name.trim(), storyId, cast: { circle: cast.some((x) => x.cast?.circle === 'protagonist') ? '' : 'protagonist' } });
    state.characters.push(c);
    go(`#/char/${c.id}/spark`);
  },
  'delete-story': async (el) => {
    const s = storyById(el.dataset.id);
    const n = castOf(s.id).length;
    if (!(await confirmDialog(t('Delete story?'), tn(n, '“{title}” and its {n} character will be permanently deleted.', '“{title}” and its {n} characters will be permanently deleted.', { title: s.title })))) return;
    await api('DELETE', `/api/stories/${s.id}`);
    state.stories = state.stories.filter((x) => x.id !== s.id);
    state.characters = state.characters.filter((x) => x.storyId !== s.id);
    go('#/');
  },
  'char-menu': async () => {
    const c = charById(state.route.id);
    const choice = await modal({
      title: displayName(c),
      body: `<div class="menu-list">
        <button class="btn ghost block" data-btn="0">${icon('file')} ${esc(t('Export Markdown bible'))}</button>
        <button class="btn ghost block" data-btn="1">${icon('download')} ${esc(t('Export JSON'))}</button>
        <button class="btn ghost block" data-btn="2">${icon('copy')} ${esc(t('Duplicate'))}</button>
        <button class="btn ghost block" data-btn="3">${icon('map')} ${esc(t('Move to another story'))}</button>
        <button class="btn ghost block" data-btn="4">${icon('sparkle')} ${esc(t('Change colour'))}</button>
        <button class="btn danger block" data-btn="5">${icon('trash')} ${esc(t('Delete character'))}</button></div>`,
      buttons: [{ label: 'md', value: 'md' }, { label: 'json', value: 'json' }, { label: 'dup', value: 'dup' }, { label: 'move', value: 'move' }, { label: 'color', value: 'color' }, { label: 'del', value: 'del' }],
      onMount: (w) => w.querySelector('footer').remove(),
    });
    if (choice === 'md') return ACTIONS['export-md']();
    if (choice === 'json') return ACTIONS['export-json']();
    if (choice === 'color') return ACTIONS['pick-color']();
    if (choice === 'dup') {
      await flushSaves();
      const copy = await api('POST', `/api/characters/${c.id}/duplicate`);
      state.characters.push(copy);
      toast(t('Duplicated'), 'success');
      return go(`#/char/${copy.id}/spark`);
    }
    if (choice === 'move') {
      const target = await modal({
        title: t('Move to story'),
        body: `<label class="field"><span class="lbl">${esc(t('Story'))}</span><select class="inp" id="move-target"><option value="">${esc(t('(no story)'))}</option>${state.stories.map((s) => `<option value="${attr(s.id)}" ${s.id === c.storyId ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select></label><p class="help">${esc(t('Relationships to characters in the old story are removed.'))}</p>`,
        buttons: [{ label: t('Cancel'), value: undefined }, { label: t('Move'), value: (w) => w.querySelector('#move-target').value, kind: 'primary' }],
      });
      if (target === undefined) return;
      c.storyId = target || null;
      c.relationships = (c.relationships || []).filter((r) => charById(r.targetId)?.storyId === c.storyId);
      scheduleSave('char', c.id);
      await flushSaves();
      return render();
    }
    if (choice === 'del') {
      if (!(await confirmDialog(t('Delete character?'), t('{name} will be permanently deleted.', { name: displayName(c) })))) return;
      await api('DELETE', `/api/characters/${c.id}`);
      state.characters = state.characters.filter((x) => x.id !== c.id);
      for (const o of state.characters) o.relationships = (o.relationships || []).filter((r) => r.targetId !== c.id);
      return go(c.storyId ? `#/story/${c.storyId}` : '#/');
    }
  },
  'pick-color': async () => {
    const c = charById(state.route.id);
    const colors = ['#e4572e', '#4c6ef5', '#12b886', '#f59f00', '#ae3ec9', '#1098ad', '#d6336c', '#5c940d', '#e8590c', '#3b5bdb', '#495057', '#c2255c'];
    const pick = await modal({
      title: t('Character colour'),
      body: `<div class="swatches">${colors.map((col, i) => `<button class="swatch ${col === c.color ? 'on' : ''}" style="background:${col}" data-btn="${i}" aria-label="${col}"></button>`).join('')}</div>`,
      buttons: colors.map((col) => ({ label: col, value: col })),
      onMount: (w) => w.querySelector('footer').remove(),
    });
    if (!pick) return;
    c.color = pick;
    scheduleSave('char', c.id);
    render();
  },
  'export-md': async () => {
    const c = charById(state.route.id);
    const ctx = ctxFor(c);
    download(exportFileName({ kind: 'character', characters: [c] }, 'md'), characterMarkdown(c, ctx.story, ctx.cast), 'text/markdown');
  },
  'export-json': () => transfer.exportCharacter(state.route.id),
  'export-dialog': (el) => transfer.openExport(el.dataset.story ? { stories: [el.dataset.story] } : {}),
  backups: () => transfer.openBackups(),
  print: () => window.print(),
  import: () => transfer.pickAndImport(),
  'restore-sample': async () => {
    const res = await api('POST', '/api/reset-sample');
    await load();
    toast(t('Sample story “{title}” restored', { title: storyById(SAMPLE_ID)?.title || '' }), 'success', 8000, undoAction(res));
    render();
  },
  'translate-sample': async () => {
    const lang = LOCALES.find((l) => l.id === getLocale())?.label || getLocale();
    if (!(await confirmDialog(t('Replace the sample story?'), t('The sample story and its characters will be replaced by the {language} version. Changes you made to them will be lost.', { language: lang }), t('Replace')))) return;
    await flushSaves();
    const res = await api('POST', '/api/reset-sample');
    await load();
    toast(t('Sample story “{title}” restored', { title: storyById(SAMPLE_ID)?.title || '' }), 'success', 8000, undoAction(res));
    render();
  },
  'toggle-lang': (el) => setLangMenu(el.getAttribute('aria-expanded') !== 'true'),
  'set-lang': async (el) => {
    setLangMenu(false);
    const id = el.dataset.lang;
    if (id === getLocale()) return;
    try { localStorage.setItem(LANG_KEY, id); } catch { /* storage unavailable */ }
    await applyLocale(id);
    render();
    assistant.render();
    document.querySelector('.lang-btn')?.focus();
    // Server-made texts (book status…) come back in the new language.
    api('GET', '/api/settings').then((ai) => { state.ai = ai; if (assistant.open) assistant.render(); }).catch(() => {});
  },
};

function focusLastItem(listPath) {
  requestAnimationFrame(() => {
    const items = document.querySelectorAll(`#station [data-list="${CSS.escape(listPath)}"]`);
    const last = [...items].filter((x) => x.matches('input, textarea')).pop();
    if (!last) return;
    const idx = last.dataset.index;
    const first = document.querySelector(`#station [data-list="${CSS.escape(listPath)}"][data-index="${idx}"]:is(input,textarea)`);
    first?.focus();
  });
}

// ── Dragging turning points on the arc chart ─────────────────────────────
let dragState = null;
app.addEventListener('pointerdown', (e) => {
  const g = e.target.closest('[data-drag="tp"]');
  if (!g) return;
  const c = charById(state.route.id);
  if (!c) return;
  e.preventDefault();
  dragState = { index: Number(g.dataset.index), c };
});
window.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const svgEl = document.querySelector('#rail-visual svg.arc');
  if (!svgEl) return;
  const rect = svgEl.getBoundingClientRect();
  const vb = svgEl.viewBox.baseVal;
  const y = ((e.clientY - rect.top) / rect.height) * vb.height;
  const pad = { t: 18, b: 34 };
  const ih = vb.height - pad.t - pad.b;
  const charge = Math.max(-5, Math.min(5, Math.round(((pad.t + ih / 2 - y) / (ih / 2)) * 5)));
  const tp = dragState.c.arc.turningPoints[dragState.index];
  if (tp && tp.charge !== charge) {
    tp.charge = charge;
    const wrap = document.getElementById('rail-visual');
    if (wrap) wrap.innerHTML = V.VISUALS.arcChart(dragState.c, ctxFor(dragState.c));
  }
});
window.addEventListener('pointerup', () => {
  if (!dragState) return;
  const { c } = dragState;
  dragState = null;
  scheduleSave('char', c.id);
  if (state.route.section === 'arc') rerenderStation();
  else refreshLive();
});

// ── Assistant bridge ─────────────────────────────────────────────────────
const assistant = new Assistant({
  api,
  getContext: currentContext,
  getAI: () => state.ai,
  setAI: (ai) => {
    state.ai = ai;
    document.querySelector('.coach-btn')?.classList.toggle('on', !!ai?.configured);
  },
  flushSaves,
  onCharacterUpdated: (updated) => {
    const i = state.characters.findIndex((x) => x.id === updated.id);
    if (i >= 0) state.characters[i] = updated;
    else state.characters.push(updated);
    if (state.route.view === 'builder') rerenderStation();
    else render();
  },
  onCharacterCreated: (c) => {
    state.characters.push(c);
    render();
  },
  openCharacter: (id) => go(`#/char/${id}/spark`),
});

// ── Import / export / backups ────────────────────────────────────────────
const transfer = createTransfer({ api, getState: () => state, load, render, flushSaves });
const undoAction = (res) => (res?.backup?.id ? { label: t('Undo'), onClick: () => transfer.undo(res.backup.id).catch((err) => toast(err.message, 'error')) } : null);

// ── Boot ─────────────────────────────────────────────────────────────────
async function load() {
  const data = await api('GET', '/api/bootstrap');
  state.stories = data.stories;
  state.characters = data.characters;
  state.ai = data.ai;
  state.recovered = data.recovered || null;
  state.server = data.server || null;
}

(async function boot() {
  try {
    const saved = localStorage.getItem('charbuild-theme');
    if (saved) document.documentElement.dataset.theme = saved;
    else if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
  } catch { /* storage unavailable */ }
  try {
    await applyLocale(preferredLocale());
  } catch (err) {
    console.warn('language load failed', err);
    localizeData(DEFAULT_LOCALE);
    setLocale(DEFAULT_LOCALE);
  }
  try {
    await load();
  } catch (err) {
    app.innerHTML = `<main class="page narrow"><div class="card empty-state"><h1>${esc(t('Can’t reach the CharBuild server'))}</h1><p>${esc(err.message)}</p><p>${tHtml('Start it with {cmd} and reload.', { cmd: '<code>npm start</code>' })}</p></div></main>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
  transfer.enableDrop();
  // Updated files but the old server still running: its API is missing pieces.
  if (!state.server || state.server.api < CLIENT_API) {
    toast(t('The CharBuild server is older than this page: stop it and start it again ({cmd}) to finish updating.', { cmd: 'npm start' }), 'warn', 30000);
  }
  // The library file couldn't be read when the server started.
  const rec = state.recovered;
  let seen = null;
  try { seen = sessionStorage.getItem('charbuild-recovered'); } catch { /* storage unavailable */ }
  if (rec && seen !== rec.file) {
    const when = rec.createdAt ? new Date(rec.createdAt).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }) : null;
    toast(when ? t('The library file was damaged. CharBuild restored the backup from {date} (the damaged file was kept as {file}).', { date: when, file: rec.file }) : t('The library file was damaged and no backup was found; the damaged file was kept as {file}.', { file: rec.file }), 'warn', 20000, { label: t('Backups'), onClick: () => transfer.openBackups() });
    try { sessionStorage.setItem('charbuild-recovered', rec.file); } catch { /* storage unavailable */ }
  }
})();

export { state };
