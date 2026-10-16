import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { sampleData } from '../server/sample.js';
import { collectKeys, placeholders } from '../scripts/i18n-keys.mjs';
import IT from '../shared/locales/it.js';
import * as K from '../shared/catalog.js';
import { SECTIONS } from '../shared/sections.js';
import { localizeData, en } from '../shared/i18n-data.js';
import { setLocale, tr, t, matchLocale } from '../shared/i18n.js';
import { characterChecks } from '../shared/analysis.js';
import { tmpDir, fakeClient, parseSSE } from './helpers.js';

async function start(opts = {}) {
  const { app } = await createApp({ dataDir: tmpDir(), seedLang: 'en', ...opts });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, url, body, lang) => {
    const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(lang ? { 'X-CharBuild-Lang': lang } : {}) };
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  if (opts.makeClient) await req('PUT', '/api/settings', { apiKey: 'sk-ant-test-key-0000' });
  return { req, close: () => new Promise((r) => server.close(r)) };
}

test('every interface string has an Italian translation with the same placeholders', () => {
  const keys = collectKeys();
  assert.ok(keys.length > 1500, `found ${keys.length} keys`);
  const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(IT, k) || !String(IT[k]).trim());
  assert.deepEqual(missing, [], 'untranslated keys');
  const mismatched = keys.filter((k) => placeholders(k).join() !== placeholders(IT[k]).join());
  assert.deepEqual(mismatched, [], 'placeholders differ');
  // Genre core values are split on " vs. " by the genre card.
  for (const g of K.PRIMARY_GENRES) assert.match(IT[g.coreValue], / vs\. /, g.coreValue);
});

test('builder data switches language in place and back; ids never change', () => {
  const ids = SECTIONS.map((s) => s.id).join();
  try {
    localizeData('it');
    setLocale('it');
    assert.equal(SECTIONS[0].title, 'La scintilla');
    assert.equal(en(SECTIONS[0], 'title'), 'The Spark');
    assert.equal(K.CIRCLES[0].label, 'Protagonista');
    assert.equal(K.PRESENTATIONAL_GENRES.find((g) => g.id === 'fantasy').label, 'Fantasy', 'context-specific entry');
    assert.equal(SECTIONS.map((s) => s.id).join(), ids);
    assert.equal(t('Ch. {n}', { n: 7 }), 'Cap. 7');
    // Checks read in Italian but keep stable English ids.
    const mara = sampleData('it').characters.find((c) => c.id === 'char_mara');
    const checks = characterChecks({ ...mara, name: '' }, null, []);
    const naming = checks.find((c) => c.id === 'spark:Name your character');
    assert.ok(naming && naming.title !== 'Name your character', 'title translated');
    assert.match(naming.ref, /^Cap\./);
  } finally {
    localizeData('en');
    setLocale('en');
  }
  assert.equal(SECTIONS[0].title, 'The Spark');
  assert.equal(K.CIRCLES[0].label, 'Protagonist');
});

test('the Italian sample story translates text only', () => {
  const enData = sampleData('en');
  const itData = sampleData('it');
  assert.equal(itData.stories[0].title, 'Risacca');
  assert.equal(itData.stories[0].sampleLang, 'it');
  assert.equal(enData.stories[0].sampleLang, 'en');
  const pick = (c) => ({ id: c.id, circle: c.cast.circle, roles: c.cast.specialRoles, dims: c.dimensions.map((d) => [d.id, d.type, d.level, d.defining]), rels: c.relationships.map((r) => [r.targetId, r.kind, r.effect, r.dimensionId]), arc: c.arc.type, mo: c.action.mo.theme, core: c.genre.coreCastRole });
  assert.deepEqual(itData.characters.map(pick), enData.characters.map(pick));
  assert.notEqual(itData.characters[0].concept.logline, enData.characters[0].concept.logline);
});

test('locale matching', () => {
  assert.equal(matchLocale('it-IT'), 'it');
  assert.equal(matchLocale('it_IT.UTF-8'), 'it');
  assert.equal(matchLocale('en-GB'), 'en');
  assert.equal(matchLocale('C.UTF-8'), null);
  assert.equal(matchLocale('de'), null);
});

test('the API answers in the requested language', async (t) => {
  const s = await start({ seed: false });
  t.after(s.close);
  const notFound = await s.req('GET', '/api/stories/nope', null, 'it');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.error, IT['Story not found']);
  assert.equal((await s.req('GET', '/api/stories/nope')).json.error, 'Story not found');

  const restored = await s.req('POST', '/api/reset-sample', null, 'it');
  assert.equal(restored.status, 200);
  const boot = await s.req('GET', '/api/bootstrap', null, 'it');
  assert.equal(boot.json.stories.find((x) => x.id === 'story_undertow').title, 'Risacca');

  const test1 = await s.req('POST', '/api/ai/test', { provider: 'openai' }, 'it');
  assert.equal(test1.json.ok, false);
  assert.equal(test1.json.error, tr('it', '{provider} has no API key yet.', { provider: 'OpenAI' }));

  const bad = await s.req('PUT', '/api/settings', { provider: 'nope' }, 'it');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, tr('it', 'Unknown AI provider “{id}”', { id: 'nope' }));
});

test('Italian book searches find McKee’s English passages', async (t) => {
  const s = await start({ seed: false });
  t.after(s.close);
  const status = (await s.req('GET', '/api/book/status')).json;
  if (!status.available) return t.skip('book not available');
  const it = (await s.req('GET', `/api/book/search?q=${encodeURIComponent('dimensione definitoria')}&limit=3`, null, 'it')).json;
  assert.ok(it.results.length > 0);
  assert.match(it.results.map((r) => r.text).join(' '), /defining/i);
});

test('the coach is told the interface language and replies in it', async (t) => {
  const script = [
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ciao!' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ancora.' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello.' }] },
  ];
  const fake = fakeClient(script);
  const s = await start({ makeClient: () => fake });
  t.after(s.close);
  const r1 = parseSSE((await s.req('POST', '/api/ai/chat', { characterId: 'char_mara', mode: 'coach', message: 'Aiutami' }, 'it')).text);
  const conv = r1.find((e) => e.type === 'conversation').data;
  assert.equal(conv.title, tr('it', 'Coaching {name}', { name: 'Mara Voss' }));
  const first = fake.calls[0].messages[0].content.map((b) => b.text).join('\n');
  assert.match(first, /<interface_language>The writer uses CharBuild in Italian/);
  assert.match(first, /01 La scintilla/);

  // Same language: no new block. The system prompt never changes.
  await s.req('POST', '/api/ai/chat', { conversationId: conv.id, mode: 'coach', message: 'Ancora' }, 'it');
  const second = fake.calls[1].messages.at(-1).content.map((b) => b.text).join('\n');
  assert.doesNotMatch(second, /interface_language/);
  assert.deepEqual(fake.calls[1].system, fake.calls[0].system);

  // Switching back to English is announced once.
  await s.req('POST', '/api/ai/chat', { conversationId: conv.id, mode: 'coach', message: 'Hello' }, 'en');
  const third = fake.calls[2].messages.at(-1).content.map((b) => b.text).join('\n');
  assert.match(third, /now uses CharBuild in English/);
  // History is append-only across all of this.
  assert.deepEqual(fake.calls[2].messages.slice(0, fake.calls[1].messages.length), fake.calls[1].messages);
});
