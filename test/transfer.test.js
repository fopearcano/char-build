import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { Store } from '../server/store.js';
import { sampleData } from '../server/sample.js';
import { exportFileName, slugify } from '../shared/transfer.js';
import { tmpDir } from './helpers.js';

async function start(opts = {}) {
  const dataDir = opts.dataDir || tmpDir();
  const { app, store } = await createApp({ dataDir, seedLang: 'en', ...opts });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { req, store, dataDir, close: () => new Promise((r) => server.close(r)) };
}

const chat = (id, characterId, text = 'hello') => ({
  id, mode: 'coach', provider: 'anthropic', characterId, storyId: 'story_undertow', title: 'Coaching', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }], display: [{ role: 'user', text }], snapshotHash: null,
});

test('file names and slugs', () => {
  assert.equal(slugify('Risacca — Atto I: “L’onda”'), 'risacca-atto-i-l-onda');
  assert.equal(slugify('   '), 'untitled');
  const day = new Date('2026-10-16T10:00:00Z');
  assert.equal(exportFileName({ kind: 'story', stories: [{ title: 'Undertow' }] }, 'json', day), 'charbuild-undertow-2026-10-16.json');
  assert.equal(exportFileName({ kind: 'library' }, 'json', day), 'charbuild-library-2026-10-16.json');
  assert.equal(exportFileName({ kind: 'character', characters: [{ name: 'Mara Voss' }] }, 'md', day), 'charbuild-mara-voss-2026-10-16.md');
});

test('export a story with its cast, single characters, or a selection', async (t) => {
  const s = await start();
  t.after(s.close);
  const loose = (await s.req('POST', '/api/characters', { name: 'Loner' })).json;
  const other = (await s.req('POST', '/api/stories', { title: 'Second' })).json;

  const all = await s.req('GET', '/api/export?download=1');
  assert.equal(all.json.kind, 'library');
  assert.equal(all.json.format, 2);
  assert.equal(all.json.stories.length, 2);
  assert.equal(all.json.characters.length, 7);
  assert.match(all.headers.get('content-disposition'), /charbuild-library-\d{4}-\d\d-\d\d\.json/);

  const story = await s.req('GET', '/api/export?stories=story_undertow&download=1');
  assert.equal(story.json.kind, 'story');
  assert.deepEqual(story.json.stories.map((x) => x.id), ['story_undertow']);
  assert.equal(story.json.characters.length, 6);
  assert.ok(story.json.characters.every((c) => c.storyId === 'story_undertow'));
  assert.match(story.headers.get('content-disposition'), /charbuild-undertow-/);
  assert.equal(story.json.chats, undefined);

  const one = (await s.req('GET', `/api/export?characters=${loose.id}`)).json;
  assert.equal(one.kind, 'character');
  assert.deepEqual(one.characters.map((c) => c.id), [loose.id]);

  const mixed = (await s.req('GET', `/api/export?stories=${other.id}&characters=char_mara,${loose.id}`)).json;
  assert.equal(mixed.kind, 'selection');
  assert.deepEqual(mixed.stories.map((x) => x.id), [other.id]);
  assert.deepEqual(mixed.characters.map((c) => c.id).sort(), ['char_mara', loose.id].sort());

  assert.equal((await s.req('GET', '/api/export?stories=story_nope')).status, 404);

  await fs.promises.writeFile(path.join(s.dataDir, 'chats', 'chat_one.json'), JSON.stringify(chat('chat_one', 'char_mara')));
  const withChats = (await s.req('GET', '/api/export?characters=char_mara&chats=1')).json;
  assert.deepEqual(withChats.chats.map((c) => c.id), ['chat_one']);
});

test('preview describes each item without changing anything', async (t) => {
  const s = await start();
  t.after(s.close);
  const file = (await s.req('GET', '/api/export?stories=story_undertow')).json;
  const mara = file.characters.find((c) => c.id === 'char_mara');
  mara.name = 'Mara V.';
  mara.updatedAt = '2099-01-01T00:00:00.000Z';
  file.characters.push({ id: 'char_new', name: 'Newcomer', storyId: 'story_undertow' });
  const before = JSON.stringify(s.store.data);
  const p = (await s.req('POST', '/api/import/preview', { data: file })).json;
  assert.equal(JSON.stringify(s.store.data), before);
  assert.equal(p.kind, 'story');
  assert.equal(p.stories[0].status, 'same');
  const byId = Object.fromEntries(p.characters.map((c) => [c.id, c]));
  assert.equal(byId.char_mara.status, 'conflict');
  assert.equal(byId.char_mara.newer, 'file');
  assert.equal(byId.char_callum.status, 'same');
  assert.equal(byId.char_new.status, 'new');
  assert.equal(byId.char_new.inFileStory, true);

  assert.equal((await s.req('POST', '/api/import/preview', { data: { app: 'other-app', stories: [] } })).status, 400);
  assert.equal((await s.req('POST', '/api/import/preview', { data: { app: 'char-build' } })).status, 400);
});

test('import choices: update, keep both (copy) and skip', async (t) => {
  const s = await start();
  t.after(s.close);
  const file = (await s.req('GET', '/api/export?stories=story_undertow')).json;
  for (const c of file.characters) c.name = `${c.name} (edited elsewhere)`;
  file.stories[0].title = 'Undertow II';

  // skip: nothing changes
  const skip = (await s.req('POST', '/api/import', { data: file, conflict: 'skip' })).json;
  assert.deepEqual(skip.skipped, { stories: 1, characters: 6, chats: 0 });
  assert.equal(s.store.getCharacter('char_mara').name, 'Mara Voss');

  // copy: a second story with its own cast under new ids; originals untouched
  const copy = (await s.req('POST', '/api/import', { data: file, conflict: 'copy' })).json;
  assert.deepEqual(copy.copied, { stories: 1, characters: 6, chats: 0 });
  assert.equal(s.store.data.stories.length, 2);
  const twin = s.store.data.stories.find((x) => x.id !== 'story_undertow');
  assert.equal(twin.title, 'Undertow II (copy)');
  const cast = s.store.listCharacters(twin.id);
  assert.equal(cast.length, 6);
  assert.ok(cast.every((c) => !file.characters.some((f) => f.id === c.id)), 'copies get new ids');
  const twinMara = cast.find((c) => c.name.startsWith('Mara Voss'));
  assert.equal(twinMara.name, 'Mara Voss (edited elsewhere)', 'no "(copy)" suffix inside a copied story');
  const castIds = new Set(cast.map((c) => c.id));
  assert.ok(twinMara.relationships.length > 0);
  assert.ok(twinMara.relationships.every((r) => castIds.has(r.targetId)), 'relationships point into the copied cast');
  assert.equal(s.store.getCharacter('char_mara').name, 'Mara Voss');
  assert.equal(s.store.listCharacters('story_undertow').length, 6);

  // update: the file wins
  const upd = (await s.req('POST', '/api/import', { data: file, conflict: 'update' })).json;
  assert.deepEqual(upd.updated, { stories: 1, characters: 6, chats: 0 });
  assert.equal(s.store.getCharacter('char_mara').name, 'Mara Voss (edited elsewhere)');
  assert.equal(s.store.getStory('story_undertow').title, 'Undertow II');
});

test('import a selection into a chosen story; links are tidied', async (t) => {
  const s = await start();
  t.after(s.close);
  const file = (await s.req('GET', '/api/export?stories=story_undertow')).json;
  const target = (await s.req('POST', '/api/stories', { title: 'Elsewhere' })).json;
  // Only Callum (whose links point at Mara), imported as a copy into another story.
  const res = (await s.req('POST', '/api/import', { data: file, conflict: 'copy', select: { stories: [], characters: ['char_callum'] }, target: target.id })).json;
  assert.equal(res.copied.characters, 1);
  const [callum] = s.store.listCharacters(target.id);
  assert.equal(callum.name, 'Callum Voss (copy)');
  assert.deepEqual(callum.relationships, [], 'links to castmates in another story are dropped');

  // A single-character file (old format) with no story in the library goes loose.
  const single = { app: 'char-build', character: { ...file.characters.find((c) => c.id === 'char_iona'), id: 'char_iona2', storyId: 'story_gone' } };
  const r2 = (await s.req('POST', '/api/import', { data: single })).json;
  assert.equal(r2.added.characters, 1);
  assert.equal(s.store.getCharacter('char_iona2').storyId, null);
  assert.deepEqual(s.store.getCharacter('char_iona2').relationships, []);

  assert.equal((await s.req('POST', '/api/import', { data: file, target: 'story_missing' })).status, 404);
  assert.equal((await s.req('POST', '/api/import', { data: file, select: { stories: [], characters: [] } })).status, 400);
});

test('chats travel with their characters and imports can be undone', async (t) => {
  const src = await start();
  t.after(src.close);
  await fs.promises.writeFile(path.join(src.dataDir, 'chats', 'chat_one.json'), JSON.stringify(chat('chat_one', 'char_mara', 'from source')));
  const file = (await src.req('GET', '/api/export?stories=story_undertow&chats=1')).json;

  const s = await start({ seed: false });
  t.after(s.close);
  const res = (await s.req('POST', '/api/import', { data: file })).json;
  assert.equal(res.added.chats, 1);
  assert.equal((await s.req('GET', '/api/ai/conversations/chat_one')).json.characterId, 'char_mara');

  // Undo = restore the backup taken just before the import.
  const undo = await s.req('POST', `/api/backups/${res.backup.id}/restore`);
  assert.equal(undo.status, 200, undo.text);
  assert.equal(s.store.data.stories.length, 0);
  assert.equal((await s.req('GET', '/api/ai/conversations/chat_one')).status, 404, 'imported chat removed');
  // …and the undo itself can be undone.
  await s.req('POST', `/api/backups/${undo.json.backup.id}/restore`);
  assert.equal(s.store.data.stories.length, 1);
  assert.equal((await s.req('GET', '/api/ai/conversations/chat_one')).status, 200);

  // Without chats
  const s2 = await start({ seed: false });
  t.after(s2.close);
  const r2 = (await s2.req('POST', '/api/import', { data: file, includeChats: false })).json;
  assert.equal(r2.added.chats, 0);
});

test('replace swaps the library and is undoable', async (t) => {
  const s = await start();
  t.after(s.close);
  const extra = (await s.req('POST', '/api/stories', { title: 'Keep me?' })).json;
  const file = (await s.req('GET', '/api/export?stories=story_undertow')).json;
  const res = (await s.req('POST', '/api/import', { data: file, replace: true })).json;
  assert.equal(res.replaced, true);
  assert.equal(res.backup.kind, 'replace');
  assert.deepEqual(s.store.data.stories.map((x) => x.id), ['story_undertow']);
  await s.req('POST', `/api/backups/${res.backup.id}/restore`);
  assert.ok(s.store.data.stories.some((x) => x.id === extra.id));
});

test('backups: listed newest first, manual snapshots, pruning', async (t) => {
  const s = await start();
  t.after(s.close);
  const made = await s.req('POST', '/api/backups');
  assert.equal(made.status, 201);
  assert.equal(made.json.kind, 'manual');
  const list = (await s.req('GET', '/api/backups')).json;
  assert.equal(list[0].id, made.json.id);
  assert.equal(list[0].stories, 1);
  assert.equal(list[0].characters, 6);
  for (let i = 0; i < 25; i++) await s.store.createBackup('manual');
  assert.ok((await s.store.listBackups()).length <= 21, 'old backups are pruned');
  assert.equal((await s.req('POST', '/api/backups/bk_missing/restore')).status, 404);
});

test('a corrupt library file is set aside and the newest backup is loaded', async () => {
  const dir = tmpDir();
  const first = await new Store(dir).init({ seed: () => sampleData('en') });
  await first.createBackup('manual');
  fs.writeFileSync(path.join(dir, 'db.json'), '{ not json');
  const second = await new Store(dir).init({ seed: () => sampleData('en') });
  assert.equal(second.data.stories.length, 1);
  assert.ok(second.recovered?.backupId);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('db.json.corrupt-')));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')));
});

test('stale saves are refused with the current version (409)', async (t) => {
  const s = await start();
  t.after(s.close);
  const mara = (await s.req('GET', '/api/characters/char_mara')).json;
  const first = await s.req('PUT', '/api/characters/char_mara', { ...mara, name: 'Device A' });
  assert.equal(first.status, 200);
  const stale = await s.req('PUT', '/api/characters/char_mara', { ...mara, name: 'Device B' });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.conflict, true);
  assert.equal(stale.json.current.name, 'Device A');
  // Keeping "mine" = saving on top of the current version.
  const mine = await s.req('PUT', '/api/characters/char_mara', { ...mara, name: 'Device B', updatedAt: stale.json.current.updatedAt });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.name, 'Device B');
  const story = (await s.req('GET', '/api/stories/story_undertow')).json;
  await s.req('PUT', '/api/stories/story_undertow', { ...story, title: 'A' });
  assert.equal((await s.req('PUT', '/api/stories/story_undertow', { ...story, title: 'B' })).status, 409);
});

test('a failed disk write is reported instead of claiming success', async (t) => {
  const s = await start();
  t.after(s.close);
  s.store.file = path.join(s.dataDir, 'missing-dir', 'db.json');
  const mara = (await s.req('GET', '/api/characters/char_mara')).json;
  const res = await s.req('PUT', '/api/characters/char_mara', { ...mara, name: 'Unsaved' });
  assert.equal(res.status, 503);
  assert.match(res.json.error, /Could not save to disk/);
});

test('deleting a character deletes its conversations', async (t) => {
  const s = await start();
  t.after(s.close);
  await fs.promises.writeFile(path.join(s.dataDir, 'chats', 'chat_iona.json'), JSON.stringify(chat('chat_iona', 'char_iona')));
  await s.req('DELETE', '/api/characters/char_iona');
  assert.equal(fs.existsSync(path.join(s.dataDir, 'chats', 'chat_iona.json')), false);
});
