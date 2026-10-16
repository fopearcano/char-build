import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { tmpDir, fakeClient, parseSSE } from './helpers.js';

async function start(opts = {}) {
  const dataDir = tmpDir();
  const { app, store } = await createApp({ dataDir, ...opts });
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
  // With a fake model client, configure a (fake) Claude key so the coach is enabled.
  if (opts.makeClient) await req('PUT', '/api/settings', { apiKey: 'sk-ant-test-key-0000' });
  return { base, req, store, dataDir, close: () => new Promise((r) => server.close(r)) };
}

test('seeds the sample and serves the SPA', async (t) => {
  const s = await start();
  t.after(s.close);
  const boot = await s.req('GET', '/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.json.stories[0].id, 'story_undertow');
  assert.equal(boot.json.characters.length, 6);
  assert.equal(boot.json.ai.configured, !!process.env.ANTHROPIC_API_KEY);
  const html = await s.req('GET', '/char/x/profile');
  assert.match(html.text, /<div id="app">/);
  const shared = await s.req('GET', '/shared/catalog.js');
  assert.match(shared.text, /PRIMARY_GENRES/);
  assert.ok(fs.existsSync(path.join(s.dataDir, 'db.json')));
});

test('story and character CRUD with validation and cascade', async (t) => {
  const s = await start({ seed: false });
  t.after(s.close);
  const story = (await s.req('POST', '/api/stories', { title: 'Noir', id: 'hacked', __proto__: { x: 1 } })).json;
  assert.notEqual(story.id, 'hacked');
  const a = (await s.req('POST', '/api/characters', { name: 'A', storyId: story.id })).json;
  const b = (await s.req('POST', '/api/characters', { name: 'B', storyId: story.id, relationships: [] })).json;
  assert.equal((await s.req('POST', '/api/characters', { name: 'C', storyId: 'story_missing' })).status, 404);

  const put = await s.req('PUT', `/api/characters/${a.id}`, { ...a, name: 'Ada', relationships: [{ id: 'r1', targetId: b.id, kind: 'foil' }], id: 'ignored' });
  assert.equal(put.json.id, a.id);
  assert.equal(put.json.name, 'Ada');

  const patch = await s.req('PATCH', `/api/characters/${a.id}`, { updates: [{ path: 'outer.implicit.bigFive.rationality', value: 20 }, { path: 'dimensions', op: 'append', value: { id: 'dim_x', positive: 'Bold', negative: 'Timid', defining: true } }, { path: 'arc.dimensionId', value: 'dim_x' }] });
  assert.equal(patch.status, 200, patch.text);
  assert.equal(patch.json.outer.implicit.bigFive.rationality, 20);
  assert.equal(patch.json.arc.dimensionId, 'dim_x');
  assert.equal((await s.req('PATCH', `/api/characters/${a.id}`, { updates: [{ path: 'cast.circle', value: 'nowhere' }] })).status, 400);
  assert.equal((await s.req('PATCH', `/api/characters/${a.id}`, { updates: [{ path: 'id', value: 'x' }] })).status, 400);

  await s.req('DELETE', `/api/characters/${b.id}`);
  assert.deepEqual((await s.req('GET', `/api/characters/${a.id}`)).json.relationships, []);
  const md = await s.req('GET', `/api/characters/${a.id}/markdown`);
  assert.match(md.text, /^# Ada/);
  await s.req('DELETE', `/api/stories/${story.id}`);
  assert.equal((await s.req('GET', `/api/characters/${a.id}`)).status, 404);
  assert.equal((await s.req('GET', '/api/characters/bad%20id')).status, 400);
});

test('export / import round-trip', async (t) => {
  const s = await start();
  t.after(s.close);
  const dump = (await s.req('GET', '/api/export')).json;
  const s2 = await start({ seed: false });
  t.after(s2.close);
  const res = await s2.req('POST', '/api/import', { data: dump, mode: 'merge' });
  assert.deepEqual(res.json, { stories: 1, characters: 6 });
  assert.equal((await s2.req('GET', '/api/characters/char_mara')).json.name, 'Mara Voss');
});

test('settings never return the key', async (t) => {
  const s = await start({ seed: false });
  t.after(s.close);
  const put = await s.req('PUT', '/api/settings', { apiKey: 'sk-ant-test-1234567890abcd', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(put.json.configured, true);
  assert.equal(put.json.source, 'settings');
  assert.equal(put.json.keyHint, 'sk-ant-…abcd');
  assert.ok(!JSON.stringify(put.json).includes('1234567890'));
  const cleared = await s.req('PUT', '/api/settings', { clearKey: true });
  assert.notEqual(cleared.json.source, 'settings');
});

test('book search endpoint', async (t) => {
  const s = await start({ seed: false });
  t.after(s.close);
  const st = (await s.req('GET', '/api/book/status')).json;
  if (!st.available) return t.skip('no epub in docs/');
  const r = (await s.req('GET', '/api/book/search?q=defining%20dimension&limit=3')).json;
  assert.equal(r.results[0].chapter, 'Ch. 9 — The Dimensional Character');
});

test('coach agent: tool loop, proposals, append-only history', async (t) => {
  const script = [
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig1' },
        { type: 'text', text: 'Let me check the book.' },
        { type: 'tool_use', id: 'tu_1', name: 'search_mckee_book', input: { query: 'center of good' } },
        { type: 'tool_use', id: 'tu_2', name: 'propose_character_updates', input: { summary: 'Sharpen her', updates: [
          { path: 'cast.centerOfGood', value: 'She protects the dead men’s children.', rationale: 'Ch. 6' },
          { path: 'dimensions', op: 'append', value: { id: 'dim_pride', positive: 'Proud', negative: 'Ashamed' } },
          { path: 'arc.dimensionId', value: 'dim_pride' },
          { path: 'cast.circle', value: 'galaxy' },
        ] } },
      ],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Proposed two changes.' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Second turn reply.' }] },
  ];
  const fake = fakeClient(script);
  const s = await start({ makeClient: () => fake });
  t.after(s.close);

  const r1 = await s.req('POST', '/api/ai/chat', { characterId: 'char_mara', mode: 'coach', message: 'Help with her empathy', section: 'role' });
  const ev = parseSSE(r1.text);
  const types = ev.map((e) => e.type);
  assert.ok(types.includes('conversation') && types.includes('proposal') && types.at(-1) === 'done', types.join(','));
  const proposal = ev.find((e) => e.type === 'proposal').data;
  assert.equal(proposal.updates.length, 3, 'invalid circle was rejected');
  const convId = ev[0].data.id;

  // first request: frozen system prompt, tools, snapshot + focus blocks
  const call1 = fake.calls[0];
  assert.equal(call1.model, 'claude-opus-5-5');
  assert.deepEqual(call1.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(call1.fallbacks, 'default');
  assert.deepEqual(call1.thinking, { type: 'adaptive', display: 'summarized' });
  assert.ok(call1.tools.every((tool) => tool.eager_input_streaming === true));
  const u1 = call1.messages[0].content.map((b) => b.text).join('\n');
  assert.match(u1, /<character_snapshot>/);
  assert.match(u1, /<focus>The writer is on station 02/);

  // tool results went back in one user message, errors flagged
  const call2 = fake.calls[1];
  const toolMsg = call2.messages.at(-1);
  assert.equal(toolMsg.role, 'user');
  assert.deepEqual(toolMsg.content.map((b) => b.tool_use_id), ['tu_1', 'tu_2']);
  assert.match(toolMsg.content[1].content, /Rejected .*cast\.circle/);
  // the assistant turn (thinking block + signature included) is passed back unchanged
  assert.equal(call2.messages[1].role, 'assistant');
  assert.deepEqual(call2.messages[1].content[0], { type: 'thinking', thinking: '', signature: 'sig1' });

  // second turn: history replayed byte-identical, no new snapshot (unchanged)
  const r2 = await s.req('POST', '/api/ai/chat', { conversationId: convId, characterId: 'char_mara', mode: 'coach', message: 'Thanks' });
  assert.equal(parseSSE(r2.text).at(-1).type, 'done');
  const call3 = fake.calls[2];
  assert.equal(call3.system[0].text, call1.system[0].text);
  const prior = [...call2.messages, { role: 'assistant', content: [{ type: 'text', text: 'Proposed two changes.' }] }];
  assert.deepEqual(call3.messages.slice(0, prior.length), prior);
  assert.equal(call3.messages.at(-1).content.length, 1, 'no snapshot when the character did not change');

  // applying the proposal through the API works, then a new snapshot rides along
  const applied = await s.req('PATCH', '/api/characters/char_mara', { updates: proposal.updates.map(({ path, op, value }) => ({ path, op, value })) });
  assert.equal(applied.status, 200, applied.text);
  assert.equal(applied.json.arc.dimensionId, 'dim_pride');
  script.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
  await s.req('POST', '/api/ai/chat', { conversationId: convId, characterId: 'char_mara', mode: 'coach', message: 'Applied' });
  assert.match(fake.calls[3].messages.at(-1).content[0].text, /<character_snapshot>[\s\S]*Proud \/ Ashamed/);

  // transcript for the UI; status update persists
  const conv = (await s.req('GET', `/api/ai/conversations/${convId}`)).json;
  assert.equal(conv.display.length, 6);
  assert.equal(conv.messages, undefined, 'raw API messages are not exposed');
  await s.req('POST', `/api/ai/conversations/${convId}/proposals/${proposal.id}`, { status: 'applied' });
  const conv2 = (await s.req('GET', `/api/ai/conversations/${convId}`)).json;
  assert.equal(conv2.display[1].proposals[0].status, 'applied');
  const list = (await s.req('GET', '/api/ai/conversations?characterId=char_mara&mode=coach')).json;
  assert.equal(list[0].id, convId);
});

test('a failed turn leaves no trace in the conversation', async (t) => {
  const err = Object.assign(new Error('boom'), {});
  const fake = fakeClient([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }, err]);
  const s = await start({ makeClient: () => fake });
  t.after(s.close);
  const r1 = parseSSE((await s.req('POST', '/api/ai/chat', { characterId: 'char_mara', mode: 'interview', message: 'Who are you?' })).text);
  const id = r1[0].data.id;
  assert.match(fake.calls[0].messages[0].content[0].text, /<dossier>/);
  assert.equal(fake.calls[0].tools, undefined, 'interview mode has no tools');
  const r2 = parseSSE((await s.req('POST', '/api/ai/chat', { conversationId: id, mode: 'interview', message: 'And then?' })).text);
  assert.equal(r2.at(-1).type, 'error');
  const conv = (await s.req('GET', `/api/ai/conversations/${id}`)).json;
  assert.equal(conv.display.length, 2);
});

test('chat input validation', async (t) => {
  const s = await start({ makeClient: () => fakeClient([]) });
  t.after(s.close);
  assert.equal((await s.req('POST', '/api/ai/chat', { mode: 'coach', message: 'x' })).status, 400);
  assert.equal((await s.req('POST', '/api/ai/chat', { characterId: 'char_nope', mode: 'coach', message: 'x' })).status, 404);
  const empty = parseSSE((await s.req('POST', '/api/ai/chat', { characterId: 'char_mara', mode: 'coach', message: '  ' })).text);
  assert.equal(empty.at(-1).type, 'error');
  const test1 = (await s.req('POST', '/api/ai/test')).json;
  assert.equal(test1.ok, true);
});

test('reachable over the LAN; AI settings stay host-only', async (t) => {
  const { lanAddresses } = await import('../server/index.js');
  const ip = lanAddresses()[0];
  if (!ip) return t.skip('no LAN interface');
  const listen = async (opts) => {
    const { app } = await createApp({ dataDir: tmpDir(), ...opts });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '0.0.0.0', () => resolve(s));
    });
    t.after(() => new Promise((r) => server.close(r)));
    return server.address().port;
  };
  const port = await listen({});
  const lan = `http://${ip}:${port}`;
  const local = `http://127.0.0.1:${port}`;

  const page = await fetch(`${lan}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="app">/);
  const boot = await (await fetch(`${lan}/api/bootstrap`)).json();
  assert.equal(boot.characters.length, 6);
  assert.equal(boot.ai.canEditSettings, false);
  assert.equal((await (await fetch(`${local}/api/settings`)).json()).canEditSettings, true);

  const put = (base) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'sk-ant-lan-test-000000' }) });
  assert.equal((await put(lan)).status, 403);
  assert.equal((await put(local)).status, 200);
  // editing characters from another device works
  const patch = await fetch(`${lan}/api/characters/char_mara`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates: [{ path: 'concept.nickname', value: 'Set from a tablet' }] }) });
  assert.equal((await patch.json()).concept.nickname, 'Set from a tablet');

  const open = await listen({ allowRemoteSettings: true });
  assert.equal((await put(`http://${ip}:${open}`)).status, 200);
});
