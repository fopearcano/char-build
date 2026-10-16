import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { resolveProvider, activeProviderId, pickChatModel } from '../server/providers.js';
import { tmpDir, fakeClient, fakeOpenAIClient, oaText, oaToolCalls, parseSSE } from './helpers.js';

async function start({ anthropic = fakeClient([]), openai = fakeOpenAIClient([]) } = {}) {
  const { app } = await createApp({ dataDir: tmpDir(), makeClient: (cfg) => (cfg.kind === 'anthropic' ? anthropic : openai) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE */ }
    return { status: res.status, json, text };
  };
  return { req, close: () => new Promise((r) => server.close(r)) };
}

test('provider registry resolves settings, env and defaults', () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'gem-key-1234567890';
  try {
    const g = resolveProvider({}, 'gemini');
    assert.equal(g.configured, true);
    assert.equal(g.source, 'env (GEMINI_API_KEY)');
    assert.equal(g.baseURL, 'https://generativelanguage.googleapis.com/v1beta/openai/');
    assert.equal(g.model, 'gemini-3.8-flash');
    const o = resolveProvider({ providers: { openai: { apiKey: 'sk-1', model: 'm', reasoningEffort: 'low' } } }, 'openai');
    assert.deepEqual([o.source, o.model, o.reasoningEffort], ['settings', 'm', 'low']);
    // legacy top-level Claude settings still count
    assert.equal(resolveProvider({ apiKey: 'sk-ant-legacy-0000', model: 'x' }, 'anthropic').model, 'x');
    assert.equal(resolveProvider({}, 'ollama').configured, true, 'local providers need no key');
    assert.equal(resolveProvider({}, 'custom').configured, false, 'custom needs a base URL');
    assert.equal(activeProviderId({ provider: 'mistral' }), 'mistral');
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
  assert.equal(pickChatModel(['text-embedding-3', 'whisper-1', 'llama3.1:8b']), 'llama3.1:8b');
});

test('settings: per-provider keys, validation, never leaking keys', async (t) => {
  const s = await start();
  t.after(s.close);
  let st = (await s.req('PUT', '/api/settings', { provider: 'openai', apiKey: 'sk-openai-secret-9999', model: 'gpt-test', reasoningEffort: 'high' })).json;
  assert.equal(st.provider, 'openai');
  assert.equal(st.model, 'gpt-test');
  const oa = st.providers.find((p) => p.id === 'openai');
  assert.deepEqual([oa.configured, oa.source, oa.keyHint, oa.reasoningEffort], [true, 'settings', 'sk-open…9999', 'high']);
  assert.ok(!JSON.stringify(st).includes('secret'));
  st = (await s.req('PUT', '/api/settings', { providerId: 'anthropic', apiKey: 'sk-ant-other-1111' })).json;
  assert.equal(st.provider, 'openai', 'updating another provider does not switch');
  assert.equal(st.providers.find((p) => p.id === 'anthropic').keyHint, 'sk-ant-…1111');
  assert.equal((await s.req('PUT', '/api/settings', { provider: 'nope' })).status, 400);
  assert.equal((await s.req('PUT', '/api/settings', { providerId: 'custom', baseURL: 'ftp://x' })).status, 400);
  st = (await s.req('PUT', '/api/settings', { provider: 'custom', baseURL: 'http://10.0.0.5:8000/v1' })).json;
  assert.equal(st.configured, true);
  st = (await s.req('PUT', '/api/settings', { providerId: 'openai', clearKey: true })).json;
  assert.equal(st.providers.find((p) => p.id === 'openai').source.startsWith('env') || st.providers.find((p) => p.id === 'openai').source === 'none', true);
});

test('OpenAI-compatible coach: streamed tool calls, JSON-text values, append-only history', async (t) => {
  const script = [
    oaToolCalls([
      { id: 'call_a', name: 'search_mckee_book', args: { query: 'defining dimension' } },
      { id: 'call_b', name: 'propose_character_updates', args: { summary: 'Sharpen', updates: [
        { path: 'cast.centerOfGood', value: 'She refuses to lie about the dead.' },
        { path: 'dimensions', op: 'append', value: '{"id":"dim_p","positive":"Proud","negative":"Ashamed"}' },
        { path: 'outer.implicit.bigFive.openness', value: '80' },
        { path: 'concept.inspiration', value: '["reality","genre"]' },
        { path: 'cast.circle', value: 'nowhere' },
      ] } },
    ], 'Let me look.'),
    oaText('Two ideas are ready for you.'),
    oaText('Second turn.'),
  ];
  const openai = fakeOpenAIClient(script);
  const s = await start({ openai });
  t.after(s.close);
  await s.req('PUT', '/api/settings', { provider: 'openai', apiKey: 'sk-test-openai-0000', model: 'gpt-test' });

  const ev = parseSSE((await s.req('POST', '/api/ai/chat', { characterId: 'char_mara', mode: 'coach', message: 'Help', section: 'dimensions' })).text);
  assert.equal(ev.at(-1).type, 'done', JSON.stringify(ev.filter((e) => e.type === 'error')));
  assert.equal(ev[0].data.provider, 'openai');
  const text = ev.filter((e) => e.type === 'text').map((e) => e.data.delta).join('');
  assert.equal(text, 'Let me look.\n\nTwo ideas are ready for you.');
  const proposal = ev.find((e) => e.type === 'proposal').data;
  const byPath = Object.fromEntries(proposal.updates.map((u) => [u.path, u.value]));
  assert.equal(byPath['outer.implicit.bigFive.openness'], 80);
  assert.deepEqual(byPath['concept.inspiration'], ['reality', 'genre']);
  assert.equal(byPath.dimensions.positive, 'Proud');
  assert.equal(proposal.updates.length, 4, 'invalid circle rejected');

  const [c1, c2, c3] = [openai.calls[0], openai.calls[1]];
  assert.equal(c1.model, 'gpt-test');
  assert.equal(c1.stream, true);
  assert.equal(c1.reasoning_effort, undefined);
  assert.equal(c1.messages[0].role, 'system');
  assert.match(c1.messages[0].content, /Field index/);
  assert.match(c1.messages[1].content, /<character_snapshot>[\s\S]*<focus>The writer is on station 09/);
  assert.ok(c1.tools.every((tool) => tool.type === 'function' && !('eager_input_streaming' in tool)));
  const propose = c1.tools.find((tool) => tool.function.name === 'propose_character_updates');
  assert.equal(propose.function.parameters.properties.updates.items.properties.value.type, 'string');
  assert.ok(c1.tools.find((tool) => tool.function.name === 'analyze_character').function.parameters.properties.focus);
  // assistant tool_calls reassembled from split chunks, then one tool message per call
  const asst = c2.messages.at(-3);
  assert.equal(asst.role, 'assistant');
  assert.deepEqual(asst.tool_calls.map((x) => x.id), ['call_a', 'call_b']);
  assert.deepEqual(JSON.parse(asst.tool_calls[0].function.arguments), { query: 'defining dimension' });
  assert.deepEqual(c2.messages.slice(-2).map((m) => [m.role, m.tool_call_id]), [['tool', 'call_a'], ['tool', 'call_b']]);
  assert.match(c2.messages.at(-1).content, /Rejected .*cast\.circle/);
  assert.equal(c3, undefined);

  // second turn replays history unchanged
  const convId = ev[0].data.id;
  await s.req('POST', '/api/ai/chat', { conversationId: convId, mode: 'coach', message: 'More' });
  const call3 = openai.calls[2];
  const prior = [...c2.messages.slice(1), { role: 'assistant', content: 'Two ideas are ready for you.' }];
  assert.deepEqual(call3.messages.slice(1, prior.length + 1), prior);
  const list = (await s.req('GET', '/api/ai/conversations?characterId=char_mara&mode=coach')).json;
  assert.equal(list[0].provider, 'openai');
  assert.equal(list[0].model, 'gpt-test');
});

test('a conversation stays on its provider after switching', async (t) => {
  const openai = fakeOpenAIClient([oaText('from openai'), oaText('still openai')]);
  const anthropic = fakeClient([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'from claude' }] }]);
  const s = await start({ openai, anthropic });
  t.after(s.close);
  await s.req('PUT', '/api/settings', { provider: 'openai', apiKey: 'sk-test-openai-0000', model: 'gpt-test' });
  const first = parseSSE((await s.req('POST', '/api/ai/chat', { characterId: 'char_mara', mode: 'interview', message: 'Who are you?' })).text);
  assert.equal(openai.calls[0].tools, undefined, 'interview mode has no tools');
  await s.req('PUT', '/api/settings', { provider: 'anthropic', apiKey: 'sk-ant-test-0000' });
  const again = parseSSE((await s.req('POST', '/api/ai/chat', { conversationId: first[0].data.id, mode: 'interview', message: 'And?' })).text);
  assert.ok(again.some((e) => e.type === 'notice' && /runs on OpenAI/.test(e.data.message)));
  assert.equal(openai.calls.length, 2);
  const fresh = parseSSE((await s.req('POST', '/api/ai/chat', { characterId: 'char_mara', mode: 'interview', message: 'Hi' })).text);
  assert.equal(fresh[0].data.provider, 'anthropic');
  assert.equal(anthropic.calls.length, 1);
});

test('models without tool support fall back to plain chat', async (t) => {
  const err = Object.assign(new Error('400 registry.ollama.ai/library/tiny does not support tools'), { status: 400 });
  const openai = fakeOpenAIClient([err, oaText('No tools, but here is my advice.')], ['tiny:latest', 'nomic-embed-text']);
  const s = await start({ openai });
  t.after(s.close);
  await s.req('PUT', '/api/settings', { provider: 'ollama' });
  const ev = parseSSE((await s.req('POST', '/api/ai/chat', { characterId: 'char_mara', mode: 'coach', message: 'Help' })).text);
  assert.equal(ev.at(-1).type, 'done');
  assert.ok(ev.some((e) => e.type === 'notice' && /Using Ollama \(local\) model “tiny:latest”/.test(e.data.message)), 'auto-picked first chat model');
  assert.ok(ev.some((e) => e.type === 'notice' && /can’t use tools/.test(e.data.message)));
  const [withTools, without] = openai.calls;
  assert.equal(withTools.model, 'tiny:latest');
  assert.ok(withTools.tools.some((tool) => tool.function.name === 'list_fields'), 'local providers get list_fields');
  assert.doesNotMatch(withTools.messages[0].content, /Field index \(path/, 'local providers get the compact prompt');
  assert.equal(without.tools, undefined);
});

test('test connection and model listing for OpenAI-compatible providers', async (t) => {
  const openai = fakeOpenAIClient([], ['gpt-a', 'gpt-b']);
  const s = await start({ openai });
  t.after(s.close);
  assert.equal((await s.req('POST', '/api/ai/test', { provider: 'mistral' })).json.ok, false, 'no key yet');
  await s.req('PUT', '/api/settings', { providerId: 'openai', apiKey: 'sk-test-openai-0000', model: 'gpt-zzz' });
  const t1 = (await s.req('POST', '/api/ai/test', { provider: 'openai' })).json;
  assert.equal(t1.ok, true);
  assert.match(t1.warning, /isn’t in OpenAI’s model list/);
  assert.deepEqual((await s.req('GET', '/api/ai/models?provider=openai')).json.models, ['gpt-a', 'gpt-b']);
  assert.equal((await s.req('GET', '/api/ai/models?provider=mistral')).status, 400);
  const tools = (await s.req('POST', '/api/ai/chat', { characterId: 'char_mara', mode: 'coach', message: 'x' })).text;
  assert.match(tools, /event: error/, 'active provider (anthropic, no key) reports a clear error');
});

test('real OpenAI SDK against a local OpenAI-compatible server (custom provider)', async (t) => {
  const express = (await import('express')).default;
  const bodies = [];
  const mock = express();
  mock.use(express.json({ limit: '5mb' }));
  mock.get('/v1/models', (req, res) => res.json({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
  mock.post('/v1/chat/completions', (req, res) => {
    bodies.push({ auth: req.headers.authorization, body: req.body });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: req.body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (bodies.length === 1) {
      send({ role: 'assistant', content: 'Checking the book.' });
      send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_mckee_book', arguments: '{"query":' } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: '"center of good"}' } }] });
      send({}, 'tool_calls');
    } else {
      send({ role: 'assistant', content: 'The Center of Good ' });
      send({ content: 'draws empathy (Ch. 6).' });
      send({}, 'stop');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const mockServer = await new Promise((resolve) => {
    const srv = mock.listen(0, '127.0.0.1', () => resolve(srv));
  });
  t.after(() => new Promise((r) => mockServer.close(r)));

  const { app } = await createApp({ dataDir: tmpDir() }); // no fake: real SDK clients
  const server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'custom', baseURL: `http://127.0.0.1:${mockServer.address().port}/v1`, apiKey: 'mock-key-123456' }) });
  assert.equal(put.status, 200);

  const tested = await (await fetch(`${base}/api/ai/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.deepEqual([tested.ok, tested.model], [true, 'mock-model'], JSON.stringify(tested));

  const sse = await (await fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'char_mara', mode: 'coach', message: 'What is the Center of Good?' }) })).text();
  const ev = parseSSE(sse);
  assert.equal(ev.at(-1).type, 'done', sse);
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.data.delta).join(''), 'Checking the book.\n\nThe Center of Good draws empathy (Ch. 6).');
  assert.ok(ev.some((e) => e.type === 'tool' && /center of good/.test(e.data.label)));
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].auth, 'Bearer mock-key-123456');
  assert.equal(bodies[0].body.model, 'mock-model');
  assert.equal(bodies[0].body.stream, true);
  const toolMsg = bodies[1].body.messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.match(toolMsg.content, /Ch\. 6|not available/);
});

test('unreachable local server gives an actionable error', async (t) => {
  const { app } = await createApp({ dataDir: tmpDir() });
  const server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'ollama', baseURL: 'http://127.0.0.1:9/v1', model: 'llama3.1' }) });
  const ev = parseSSE(await (await fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'char_mara', mode: 'coach', message: 'hi' }) })).text());
  assert.equal(ev.at(-1).type, 'error');
  assert.match(ev.at(-1).data.message, /Could not reach Ollama \(local\) at http:\/\/127\.0\.0\.1:9\/v1\. Is it running/);
});
