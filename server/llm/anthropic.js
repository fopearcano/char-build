// Claude via the Anthropic SDK: streamed, adaptive thinking, manual
// tool-use loop. History is passed back unchanged (thinking blocks and
// signatures included) and only ever appended to.

import Anthropic from '@anthropic-ai/sdk';
import { format, i18nError } from '../../shared/i18n.js';

export function createAnthropicClient(cfg) {
  return cfg.apiKey ? new Anthropic({ apiKey: cfg.apiKey }) : new Anthropic();
}

export async function testAnthropic(client, cfg) {
  const info = await client.models.retrieve(cfg.model);
  return { ok: true, model: info.id, name: info.display_name };
}

export async function listAnthropicModels(client) {
  const page = await client.models.list({ limit: 100 });
  return (page.data || []).map((m) => m.id);
}

export function closingMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

// Runs one user turn. Returns the provider-format messages to append.
export async function runAnthropicTurn({ client, cfg, system, history, userBlocks, tools, runTool, emit, signal, maxIterations, say = format }) {
  const turn = [{ role: 'user', content: userBlocks.map((text) => ({ type: 'text', text })) }];
  let textSoFar = '';
  let stopReason = null;
  let jsonRetries = 0;

  for (let i = 0; i < maxIterations; i++) {
    const params = {
      model: cfg.model,
      max_tokens: 64000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [...history, ...turn],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: cfg.effort },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
    if (tools?.length) params.tools = tools;

    const stream = client.beta.messages.stream(params, { signal });
    let msg;
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            textSoFar += event.delta.text;
            emit('text', { delta: event.delta.text });
          } else if (event.delta.type === 'thinking_delta') {
            emit('thinking', { delta: event.delta.thinking });
          }
        } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          emit('tool_start', { name: event.content_block.name });
        } else if (event.type === 'content_block_start' && event.content_block.type === 'text' && textSoFar && !textSoFar.endsWith('\n')) {
          // separate prose from successive tool rounds
          textSoFar += '\n\n';
          emit('text', { delta: '\n\n' });
        }
      }
      msg = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // With eager input streaming an unparseable tool input rejects the
      // stream with the SDK's "Unable to parse tool parameter JSON" error;
      // retry that turn a couple of times. Everything else is rethrown.
      const jsonError = err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && /parse tool parameter JSON/i.test(err.message);
      if (!jsonError || signal?.aborted || jsonRetries++ >= 2) throw err;
      emit('notice', { message: say('Retrying a malformed tool call…') });
      continue;
    }

    stopReason = msg.stop_reason;
    if (stopReason === 'refusal') {
      throw i18nError(422, 'The model declined this request. Try rephrasing it.');
    }
    const toolUses = msg.content.filter((b) => b.type === 'tool_use');
    if (stopReason === 'max_tokens' && toolUses.length) throw i18nError(502, 'A tool call was cut off (max_tokens). Try a narrower request.');
    turn.push({ role: 'assistant', content: msg.content });
    if (stopReason === 'pause_turn') continue;
    if (!toolUses.length) break;

    // All results go back in a single user message.
    const results = [];
    for (const tu of toolUses) {
      const r = await runTool(tu.name, tu.input);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, ...(r.error ? { is_error: true } : {}) });
    }
    turn.push({ role: 'user', content: results });
    if (i === maxIterations - 1) emit('notice', { message: say('Stopped after several tool rounds.') });
  }
  return { messages: turn, stopReason };
}
