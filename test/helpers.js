// Test helpers: temp data dirs and a scripted fake of the Anthropic client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'charbuild-test-'));
}

// Each script entry is a final message ({content, stop_reason}); the fake
// stream yields text deltas for its text blocks and resolves finalMessage().
export function fakeClient(script) {
  const calls = [];
  const client = {
    calls,
    models: { retrieve: async (id) => ({ id, display_name: 'Fake Model' }) },
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const next = script.shift();
          if (!next) throw new Error('fake client: script exhausted');
          if (next instanceof Error) {
            return {
              async *[Symbol.asyncIterator]() { throw next; },
              finalMessage: async () => { throw next; },
            };
          }
          const message = { id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: params.model, usage: {}, ...next };
          return {
            async *[Symbol.asyncIterator]() {
              for (const [index, block] of message.content.entries()) {
                yield { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: block.type, text: '' } };
                if (block.type === 'text') yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } };
                yield { type: 'content_block_stop', index };
              }
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  };
  return client;
}

export function parseSSE(text) {
  return text.split('\n\n').filter(Boolean).map((chunk) => {
    const type = chunk.match(/^event: (.*)$/m)?.[1];
    const data = chunk.match(/^data: (.*)$/m)?.[1];
    return { type, data: data ? JSON.parse(data) : null };
  });
}

// ── OpenAI-compatible fakes ──────────────────────────────────────────────
const chunk = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });

export function oaText(text, finish = 'stop') {
  const cut = Math.ceil(text.length / 2);
  return [chunk({ role: 'assistant', content: text.slice(0, cut) }), chunk({ content: text.slice(cut) }), chunk({}, finish)];
}

// calls: [{ id, name, args (object) }] — arguments arrive split across chunks.
export function oaToolCalls(calls, text = '') {
  const out = text ? [chunk({ role: 'assistant', content: text })] : [];
  calls.forEach((c, index) => {
    const args = JSON.stringify(c.args);
    const cut = Math.ceil(args.length / 2);
    out.push(chunk({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] }));
    out.push(chunk({ tool_calls: [{ index, function: { arguments: args.slice(0, cut) } }] }));
    out.push(chunk({ tool_calls: [{ index, function: { arguments: args.slice(cut) } }] }));
  });
  out.push(chunk({}, 'tool_calls'));
  return out;
}

export function fakeOpenAIClient(script, models = ['gpt-test']) {
  const calls = [];
  return {
    calls,
    models: { list: async () => ({ data: models.map((id) => ({ id })) }) },
    chat: {
      completions: {
        create: async (params) => {
          calls.push(structuredClone(params));
          const next = script.shift();
          if (!next) throw new Error('fake openai client: script exhausted');
          if (next instanceof Error) throw next;
          return (async function* stream() {
            for (const c of next) yield c;
          })();
        },
      },
    },
  };
}
