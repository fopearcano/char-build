// Optional AI support: a Claude-powered "McKee coach" that proposes
// field-level updates, and an "interview" mode in which the character tells
// her self-story in her own voice. Streams to the browser over SSE.
//
// History is append-only: each conversation keeps the full API message list
// (thinking and tool blocks included) and only ever appends to it; the
// system prompt and tool set are fixed per mode. The live character state
// rides along as a snapshot block in the next user message whenever it
// changes, instead of editing the system prompt.

import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import * as K from '../shared/catalog.js';
import { SECTIONS, SECTION_BY_ID } from '../shared/sections.js';
import { describeFieldIndex, validateUpdate } from '../shared/fields.js';
import { characterChecks, characterDigest, overallProgress, antagonismProfile, traitDensity, choiceDepth } from '../shared/analysis.js';
import { displayName, uid } from '../shared/model.js';
import { searchBook, bookStatus } from './book.js';
import { updateContext } from './store.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_ITERATIONS = 8;

// ── Prompts (frozen per mode so the prefix stays cacheable) ──────────────

function frameworkSummary() {
  return SECTIONS.map((s) => `${s.num} ${s.title} (${s.subtitle}; Ch. ${s.chapters.join(', ')}): ${s.principle}`).join('\n');
}

const COACH_SYSTEM = `You are the CharBuild Coach, a character-design collaborator for fiction writers. Your method is Robert McKee's book CHARACTER: The Art of Role and Cast Design for Page, Stage, and Screen (2021). The writer is building a character in a structured builder app whose sixteen stations follow the book.

How you work:
- Think like McKee: push for specificity over generality, contradiction over consistency, choices under pressure over description. Hunt clichés and name them. Keep the protagonist an underdog, find the Center of Good, make the conscious and subconscious desires collide, give dimensions both poles in action, and tune the inciting incident to the character's need.
- Be a collaborator, not a lecturer. Ask one or two sharp questions when the writer's intent is unclear; offer two or three distinct options when brainstorming. Keep chat replies short and concrete (a few short paragraphs or a tight list). Cite chapters like "(Ch. 9)".
- Ground claims about the book with the search_mckee_book tool when a point is specific or the writer asks "what does McKee say". The book is copyrighted: paraphrase, and quote at most a sentence or two at a time.
- When you have concrete content for the builder, call propose_character_updates. The writer reviews every proposal and applies it with a click, so propose freely but precisely: use exact paths and option ids from the field index below, fill empty fields first, and say in "rationale" why each value serves the character. Don't overwrite a filled field unless you are improving it and say so. Never claim that an update was applied — only the writer can apply it.
- Use analyze_character for a McKee diagnostic of the live character (progress, checks, scores) before giving an overall critique.
- Use propose_cast_member to suggest new roles (foils, antagonists, first-circle helpers) that would draw out specific dimensions.
- Each user turn may begin with a <character_snapshot> of the live character and a <focus> naming the station the writer is on. The newest snapshot is the truth; earlier ones are history.
- Write in the writer's language. Never invent facts about the writer's story that contradict the snapshot.

The sixteen stations:
${frameworkSummary()}

Field index (path — label — type). Lists accept op "append" with one item object; multi-selects accept "set" (whole array) or "append"; everything else uses "set". New list items get ids automatically, but you may set an "id" on a new dimension (e.g. "dim_pride") so other updates in the same proposal can reference it.
${describeFieldIndex()}

Option glossary:
Circles: ${K.CIRCLES.map((o) => `${o.id}=${o.label}`).join('; ')}
Dimension types: ${K.DIMENSION_TYPES.map((o) => `${o.id}=${o.label}`).join('; ')}
Self levels: ${K.SELF_LEVELS.map((o) => `${o.id}=${o.label}`).join('; ')}
Primary genres: ${K.PRIMARY_GENRES.map((g) => `${g.id}=${g.label} (core value ${g.coreValue}; core cast ${g.coreCast.join('/')})`).join('; ')}
MO themes: ${K.MO_THEMES.map((o) => `${o.id}=${o.label}`).join('; ')}`;

const INTERVIEW_SYSTEM = `You are performing a fictional character in an improvised interview with the writer who is creating you. This is McKee's "self-story" exercise (CHARACTER, Ch. 4): the writer sits the character down and asks about high points, low points, turning points, successes, failures, dilemmas and beliefs, then judges truth from self-serving spin.

Rules of the performance:
- Speak only as the character, in the first person, in her voice, vocabulary and rhythm as described in the dossier. No narration, no stage directions beyond a brief gesture in italics when it reveals something.
- Everything you know about yourself comes from the dossier in the conversation. Where it is silent, improvise consistently with it — and keep improvisations modest so the writer stays the author.
- All statements of self are self-serving. Tell your life the way you believe it, with your rationalizations, blind spots and self-deceptions. Your core self keeps secrets; your hidden (subconscious) self is not known to you — never state it outright, but let it leak through contradiction, deflection and what you won't say.
- Answer the question asked, at conversational length (usually under 150 words). React to the writer as the character would to this kind of questioner.
- If the writer writes a line in [square brackets], step out of character for that reply only and answer briefly as a neutral author's assistant, then return to character.
- If a dossier update arrives mid-interview, the newest version is the truth.`;

// ── Tool definitions ──────────────────────────────────────────────────────

const COACH_TOOLS = [
  {
    name: 'search_mckee_book',
    description: 'Full-text search over the writer\'s own copy of McKee\'s CHARACTER. Returns short passages with chapter and section. Use it to ground specific claims about what the book says.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "defining dimension" or "center of good empathy".' },
        max_results: { type: 'integer', minimum: 1, maximum: 8, description: 'Default 4.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'analyze_character',
    description: 'Run the app\'s McKee diagnostics on the live character: completeness per station, derived scores (trait density, underdog balance, choice depth) and rule-of-thumb checks with chapter references.',
    eager_input_streaming: true,
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_character_updates',
    description: 'Propose concrete values for fields of the current character. The writer sees each update with your rationale and applies or dismisses it. Paths and value types must match the field index in the system prompt.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One line describing the proposal as a whole.' },
        updates: {
          type: 'array',
          minItems: 1,
          maxItems: 24,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              op: { type: 'string', enum: ['set', 'append'] },
              value: { description: 'String, number, boolean, array of option ids, or an object for list items.' },
              rationale: { type: 'string', description: 'Why this value, briefly, in McKee\'s terms.' },
            },
            required: ['path', 'value'],
          },
        },
      },
      required: ['summary', 'updates'],
    },
  },
  {
    name: 'propose_cast_member',
    description: 'Suggest a new character for the story\'s cast. The writer can add it with one click.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        roleLabel: { type: 'string', description: 'Generic role, e.g. "Mentor", "Rival sister".' },
        circle: { type: 'string', enum: K.CIRCLES.map((c) => c.id) },
        logline: { type: 'string' },
        specialRoles: { type: 'array', items: { type: 'string', enum: K.SPECIAL_ROLES.map((r) => r.id) } },
        draws: { type: 'string', description: 'Which trait or dimension of the current character this role draws out.' },
        reason: { type: 'string' },
      },
      required: ['name', 'roleLabel', 'circle', 'reason'],
    },
  },
];

const SearchInput = z.object({ query: z.string().min(1).max(300), max_results: z.number().int().min(1).max(8).optional() });
const ProposeInput = z.object({
  summary: z.string().max(500),
  updates: z.array(z.object({ path: z.string(), op: z.enum(['set', 'append']).optional(), value: z.any(), rationale: z.string().max(1500).optional() })).min(1).max(24),
});
const CastInput = z.object({
  name: z.string().min(1).max(120),
  roleLabel: z.string().max(120),
  circle: z.enum(K.CIRCLES.map((c) => c.id)),
  logline: z.string().max(600).optional(),
  specialRoles: z.array(z.enum(K.SPECIAL_ROLES.map((r) => r.id))).optional(),
  draws: z.string().max(400).optional(),
  reason: z.string().max(1000),
});

// ── Service ───────────────────────────────────────────────────────────────

export function createAI({ store, rootDir, makeClient }) {
  const credentials = () => {
    if (store.settings.apiKey) return { source: 'settings', apiKey: store.settings.apiKey };
    if (process.env.ANTHROPIC_API_KEY) return { source: 'env', apiKey: process.env.ANTHROPIC_API_KEY };
    if (process.env.ANTHROPIC_AUTH_TOKEN) return { source: 'env-token' };
    return { source: 'none' };
  };

  const client = () => {
    const cred = credentials();
    if (makeClient) return makeClient(cred);
    return cred.apiKey ? new Anthropic({ apiKey: cred.apiKey }) : new Anthropic();
  };

  const model = () => store.settings.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const effort = () => (EFFORTS.includes(store.settings.effort) ? store.settings.effort : 'medium');

  function status() {
    const cred = credentials();
    const key = cred.apiKey || '';
    return {
      configured: cred.source !== 'none',
      source: cred.source,
      keyHint: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null,
      model: model(),
      effort: effort(),
      book: bookStatus(rootDir),
    };
  }

  async function test() {
    const info = await client().models.retrieve(model());
    return { ok: true, model: info.id, name: info.display_name };
  }

  function contextFor(characterId) {
    const character = store.getCharacter(characterId);
    const story = character.storyId ? store.data.stories.find((s) => s.id === character.storyId) : null;
    const cast = character.storyId ? store.listCharacters(character.storyId) : [character];
    return { character, story, cast };
  }

  async function runTool(name, input, chat, emit) {
    switch (name) {
      case 'search_mckee_book': {
        const parsed = SearchInput.safeParse(input);
        if (!parsed.success) return { error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(input) }) };
        const res = searchBook(rootDir, parsed.data.query, parsed.data.max_results || 4);
        emit('tool', { name, label: `Searched the book: “${parsed.data.query}”`, results: res.results?.map((r) => ({ chapter: r.chapter, section: r.section })) });
        if (!res.available) return { content: `The book is not available (${res.reason}). Rely on the framework summary instead and say so.` };
        if (!res.results.length) return { content: 'No passages matched. Try different keywords.' };
        return { content: res.results.map((r, i) => `[${i + 1}] ${r.chapter}${r.section ? ` · ${r.section}` : ''}\n${r.text}`).join('\n\n') };
      }
      case 'analyze_character': {
        const { character, story, cast } = contextFor(chat.characterId);
        const progress = overallProgress(character, story);
        const ap = antagonismProfile(character);
        const td = traitDensity(character);
        const checks = characterChecks(character, story, cast);
        emit('tool', { name, label: 'Ran the McKee diagnostics' });
        return {
          content: JSON.stringify({
            progress: Math.round(progress.ratio * 100) + '%',
            stations: Object.fromEntries(Object.entries(progress.bySection).filter(([, v]) => v.expected).map(([k, v]) => [k, `${v.filled}/${v.total}`])),
            traitDensity: { known: td.known, dramatized: td.expressed, ratio: Math.round(td.expressedRatio * 100) / 100, ideal: 0.3 },
            underdog: { antagonism: ap.power, capacity: ap.capacity, levelsEngaged: ap.levelsEngaged, isUnderdog: ap.underdog },
            choiceDepth: choiceDepth(character),
            dimensions: (character.dimensions || []).length,
            checks: checks.map((c) => `[${c.level}] ${SECTION_BY_ID[c.section]?.title || c.section}: ${c.title} — ${c.detail} (${c.ref})`),
          }),
        };
      }
      case 'propose_character_updates': {
        const parsed = ProposeInput.safeParse(input);
        if (!parsed.success) return { error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(input) }) };
        const { character, cast } = contextFor(chat.characterId);
        const ctx = updateContext(character, cast, parsed.data.updates);
        const accepted = [];
        const rejected = [];
        for (const u of parsed.data.updates) {
          const r = validateUpdate(u, ctx);
          if (r.ok) accepted.push({ ...r.update, rationale: u.rationale || '' });
          else rejected.push(r.error);
        }
        if (accepted.length) {
          const proposal = { id: uid('prop'), kind: 'updates', characterId: chat.characterId, summary: parsed.data.summary, updates: accepted, status: 'pending' };
          chat.pendingProposals.push(proposal);
          emit('proposal', proposal);
        }
        const parts = [];
        if (accepted.length) parts.push(`${accepted.length} update(s) shown to the writer for review. They are not applied until the writer accepts them.`);
        if (rejected.length) parts.push(`Rejected (fix and re-propose if useful): ${rejected.join('; ')}`);
        return { error: !accepted.length, content: parts.join('\n') };
      }
      case 'propose_cast_member': {
        const parsed = CastInput.safeParse(input);
        if (!parsed.success) return { error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(input) }) };
        const { character } = contextFor(chat.characterId);
        const proposal = { id: uid('prop'), kind: 'cast', characterId: chat.characterId, storyId: character.storyId, summary: `New cast member: ${parsed.data.name}`, member: parsed.data, status: 'pending' };
        chat.pendingProposals.push(proposal);
        emit('proposal', proposal);
        return { content: `Suggested ${parsed.data.name} to the writer as a ${parsed.data.circle}-circle role. Not added until the writer accepts.` };
      }
      default:
        return { error: true, content: `Unknown tool ${name}` };
    }
  }

  function snapshotBlock(chat, section) {
    const { character, story, cast } = contextFor(chat.characterId);
    const digest = characterDigest(character, story, cast);
    const hash = crypto.createHash('sha1').update(digest).digest('hex');
    const blocks = [];
    if (hash !== chat.snapshotHash) {
      chat.snapshotHash = hash;
      blocks.push({ type: 'text', text: chat.mode === 'interview' ? `<dossier>\n${digest}\n</dossier>` : `<character_snapshot>\n${digest}\n</character_snapshot>` });
    }
    if (chat.mode === 'coach' && section && SECTION_BY_ID[section]) {
      const s = SECTION_BY_ID[section];
      blocks.push({ type: 'text', text: `<focus>The writer is on station ${s.num} “${s.title}” (Ch. ${s.chapters.join(', ')}).</focus>` });
    }
    return blocks;
  }

  async function getOrCreateChat({ conversationId, mode, characterId }) {
    if (conversationId) {
      const chat = await store.loadChat(conversationId);
      if (!chat) throw Object.assign(new Error('Conversation not found'), { status: 404 });
      return chat;
    }
    const character = store.getCharacter(characterId);
    const now = new Date().toISOString();
    return {
      id: uid('chat'),
      mode,
      characterId,
      storyId: character.storyId,
      title: mode === 'interview' ? `Interview with ${displayName(character)}` : `Coaching ${displayName(character)}`,
      createdAt: now,
      updatedAt: now,
      messages: [],
      display: [],
      snapshotHash: null,
    };
  }

  // Runs one user turn; emits SSE events through `emit(type, data)`.
  async function chat({ conversationId, mode = 'coach', characterId, message, section }, emit, signal) {
    if (!['coach', 'interview'].includes(mode)) throw Object.assign(new Error('Unknown mode'), { status: 400 });
    const text = String(message || '').trim();
    if (!text) throw Object.assign(new Error('Empty message'), { status: 400 });
    if (text.length > 20000) throw Object.assign(new Error('Message too long'), { status: 400 });
    const chat = await getOrCreateChat({ conversationId, mode, characterId });
    chat.pendingProposals = [];
    emit('conversation', { id: chat.id, mode: chat.mode, title: chat.title });

    const prevHash = chat.snapshotHash;
    const userContent = [...snapshotBlock(chat, section), { type: 'text', text }];
    const turn = [{ role: 'user', content: userContent }];
    const display = { role: 'assistant', text: '', thinking: '', tools: [], proposals: [] };
    const anthropic = client();
    const system = mode === 'interview' ? INTERVIEW_SYSTEM : COACH_SYSTEM;
    let stopReason = null;
    let jsonRetries = 0;

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const params = {
          model: model(),
          max_tokens: 64000,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: [...chat.messages, ...turn],
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: effort() },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        };
        if (mode === 'coach') params.tools = COACH_TOOLS;

        const stream = anthropic.beta.messages.stream(params, { signal });
        let msg;
        try {
          for await (const event of stream) {
            if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                display.text += event.delta.text;
                emit('text', { delta: event.delta.text });
              } else if (event.delta.type === 'thinking_delta') {
                display.thinking += event.delta.thinking;
                emit('thinking', { delta: event.delta.thinking });
              }
            } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
              emit('tool_start', { name: event.content_block.name });
            } else if (event.type === 'content_block_start' && event.content_block.type === 'text' && display.text && !display.text.endsWith('\n')) {
              // separate prose from successive tool rounds
              display.text += '\n\n';
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
          emit('notice', { message: 'Retrying a malformed tool call…' });
          continue;
        }

        stopReason = msg.stop_reason;
        if (stopReason === 'refusal') {
          throw Object.assign(new Error('The model declined this request. Try rephrasing it.'), { status: 422 });
        }
        const toolUses = msg.content.filter((b) => b.type === 'tool_use');
        if (stopReason === 'max_tokens' && toolUses.length) throw new Error('A tool call was cut off (max_tokens). Try a narrower request.');
        turn.push({ role: 'assistant', content: msg.content });
        if (stopReason === 'pause_turn') continue;
        if (!toolUses.length) break;

        const results = [];
        for (const tu of toolUses) {
          const r = await runTool(tu.name, tu.input, chat, (type, data) => {
            if (type === 'tool') display.tools.push(data);
            if (type === 'proposal') display.proposals.push(data);
            emit(type, data);
          });
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, ...(r.error ? { is_error: true } : {}) });
        }
        turn.push({ role: 'user', content: results });
        if (i === MAX_ITERATIONS - 1) emit('notice', { message: 'Stopped after several tool rounds.' });
      }
    } catch (err) {
      chat.snapshotHash = prevHash; // nothing from this turn is kept
      throw err;
    }

    // The turn completed: append it (never rewrite earlier history).
    // A trailing tool_result turn (iteration cap) would leave the model
    // waiting on a reply, so close it with a short assistant note.
    if (turn[turn.length - 1].role === 'user') turn.push({ role: 'assistant', content: [{ type: 'text', text: '(Paused after several tool rounds.)' }] });
    chat.messages.push(...turn);
    chat.display.push({ role: 'user', text, section: section || null, at: new Date().toISOString() });
    chat.display.push({ ...display, at: new Date().toISOString() });
    chat.updatedAt = new Date().toISOString();
    delete chat.pendingProposals;
    await store.saveChat(chat);
    emit('done', { stopReason, conversationId: chat.id });
    return chat;
  }

  async function setProposalStatus(conversationId, proposalId, statusValue) {
    const chat = await store.loadChat(conversationId);
    if (!chat) throw Object.assign(new Error('Conversation not found'), { status: 404 });
    for (const d of chat.display) for (const p of d.proposals || []) if (p.id === proposalId) p.status = statusValue;
    await store.saveChat(chat);
    return { ok: true };
  }

  return { status, test, chat, setProposalStatus };
}

export function publicChat(chat) {
  if (!chat) return null;
  const { messages, snapshotHash, ...rest } = chat;
  return rest;
}
