// OpenAI and every OpenAI-compatible service (Gemini, OpenRouter, Mistral,
// Groq, DeepSeek, xAI, Ollama, LM Studio, custom) via Chat Completions:
// streamed, with a manual function-calling loop.

import OpenAI from 'openai';

export function createOpenAIClient(cfg) {
  const defaultHeaders = cfg.id === 'openrouter' ? { 'HTTP-Referer': 'https://github.com/fopearcano/char-build', 'X-Title': 'CharBuild' } : undefined;
  return new OpenAI({
    apiKey: cfg.apiKey || 'not-needed', // local servers ignore it, but the SDK requires one
    baseURL: cfg.baseURL,
    defaultHeaders,
    maxRetries: 1,
    timeout: 10 * 60 * 1000,
  });
}

export async function listOpenAIModels(client) {
  const page = await client.models.list();
  return (page.data || page || []).map((m) => m.id).filter(Boolean).sort();
}

export function closingMessage(text) {
  return { role: 'assistant', content: text };
}

// Neutral (Anthropic-style) tool definitions → OpenAI function tools.
export function toOpenAITools(tools) {
  return tools.map(({ name, description, input_schema }) => ({
    type: 'function',
    function: { name, description, parameters: input_schema },
  }));
}

const isToolsUnsupported = (err) => err?.status === 400 && /tool|function/i.test(err?.message || '');

// Runs one user turn. Returns the provider-format messages to append.
export async function runOpenAITurn({ client, cfg, system, history, userBlocks, tools, runTool, emit, signal, maxIterations }) {
  const turn = [{ role: 'user', content: userBlocks.join('\n\n') }];
  let fnTools = tools?.length ? toOpenAITools(tools) : null;
  let textSoFar = '';
  let finish = null;

  for (let i = 0; i < maxIterations; i++) {
    const params = {
      model: cfg.model,
      messages: [{ role: 'system', content: system }, ...history, ...turn],
      stream: true,
    };
    if (fnTools) params.tools = fnTools;
    if (cfg.reasoningEffort) params.reasoning_effort = cfg.reasoningEffort;

    let stream;
    try {
      stream = await client.chat.completions.create(params, { signal });
    } catch (err) {
      if (fnTools && isToolsUnsupported(err)) {
        // Some (mostly local) models can't call tools; keep coaching without them.
        fnTools = null;
        emit('notice', { message: `“${cfg.model}” can’t use tools, so book search and one-click proposals are off for this reply.` });
        i -= 1;
        continue;
      }
      throw err;
    }

    let content = '';
    let started = false;
    const calls = [];
    finish = null;
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (typeof reasoning === 'string' && reasoning) emit('thinking', { delta: reasoning });
      if (typeof d.content === 'string' && d.content) {
        if (!started && textSoFar && !textSoFar.endsWith('\n')) {
          textSoFar += '\n\n';
          emit('text', { delta: '\n\n' });
        }
        started = true;
        content += d.content;
        textSoFar += d.content;
        emit('text', { delta: d.content });
      }
      for (const tc of d.tool_calls || []) {
        let slot = Number.isInteger(tc.index) ? calls[tc.index] : tc.id ? calls.find((c) => c?.id === tc.id) : null;
        if (!slot) {
          slot = { id: '', name: '', args: '' };
          if (Number.isInteger(tc.index)) calls[tc.index] = slot;
          else calls.push(slot);
          if (tc.function?.name) emit('tool_start', { name: tc.function.name });
        }
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name && !slot.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const toolCalls = calls.filter(Boolean).map((c, k) => ({
      id: c.id || `call_${i}_${k}`,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }));
    if (finish === 'content_filter') throw Object.assign(new Error(`${cfg.label} filtered this response. Try rephrasing it.`), { status: 422 });
    if (finish === 'length' && toolCalls.length) throw new Error('A tool call was cut off by the length limit. Try a narrower request.');

    const assistant = { role: 'assistant', content: content || (toolCalls.length ? null : '') };
    if (toolCalls.length) assistant.tool_calls = toolCalls;
    turn.push(assistant);
    if (!toolCalls.length) break;

    for (const tc of toolCalls) {
      let input = null;
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch {
        input = null;
      }
      const r = input && typeof input === 'object'
        ? await runTool(tc.function.name, input, { looseValues: true })
        : { error: true, content: JSON.stringify({ INVALID_JSON: tc.function.arguments }) };
      turn.push({ role: 'tool', tool_call_id: tc.id, content: r.error ? `Error: ${r.content}` : r.content });
    }
    if (i === maxIterations - 1) emit('notice', { message: 'Stopped after several tool rounds.' });
  }
  return { messages: turn, stopReason: finish };
}
