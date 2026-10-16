// Optional AI support: a "McKee coach" that proposes field-level updates,
// and an "interview" mode in which the character tells her self-story in her
// own voice. Streams to the browser over SSE. Works with Claude (Anthropic
// SDK) or any OpenAI-compatible service (see providers.js).
//
// History is append-only: each conversation keeps the full provider message
// list (thinking and tool blocks included) and only ever appends to it; the
// system prompt and tool set are fixed per mode and provider. The live
// character state rides along as a snapshot block in the next user message
// whenever it changes, instead of editing the system prompt.

import crypto from 'node:crypto';
import { z } from 'zod';
import * as K from '../shared/catalog.js';
import { SECTIONS, SECTION_BY_ID } from '../shared/sections.js';
import { describeFieldIndex, validateUpdate } from '../shared/fields.js';
import { characterChecks, characterDigest, overallProgress, antagonismProfile, traitDensity, choiceDepth } from '../shared/analysis.js';
import { displayName, uid } from '../shared/model.js';
import { searchBook, bookStatus } from './book.js';
import { updateContext } from './store.js';
import { PROVIDERS, PROVIDER_BY_ID, ANTHROPIC_EFFORTS, REASONING_EFFORTS, resolveProvider, activeProviderId, publicProvider, pickChatModel } from './providers.js';
import { createAnthropicClient, runAnthropicTurn, testAnthropic, listAnthropicModels, closingMessage as anthropicClosing } from './llm/anthropic.js';
import { createOpenAIClient, runOpenAITurn, listOpenAIModels, closingMessage as openaiClosing } from './llm/openai.js';
import { tr, i18nError, DEFAULT_LOCALE } from '../shared/i18n.js';
import './i18n.js';

export const DEFAULT_MODEL = PROVIDER_BY_ID.anthropic.defaultModel;
const MAX_ITERATIONS = 8;

// ── Prompts (frozen per mode so the prefix stays cacheable) ──────────────

function frameworkSummary() {
  return SECTIONS.map((s) => `${s.num} ${s.title} (${s.subtitle}; Ch. ${s.chapters.join(', ')}): ${s.principle}`).join('\n');
}

const COACH_RULES = `You are the CharBuild Coach, a character-design collaborator for fiction writers. Your method is Robert McKee's book CHARACTER: The Art of Role and Cast Design for Page, Stage, and Screen (2021). The writer is building a character in a structured builder app whose sixteen stations follow the book.

How you work:
- Think like McKee: push for specificity over generality, contradiction over consistency, choices under pressure over description. Hunt clichés and name them. Keep the protagonist an underdog, find the Center of Good, make the conscious and subconscious desires collide, give dimensions both poles in action, and tune the inciting incident to the character's need.
- Be a collaborator, not a lecturer. Ask one or two sharp questions when the writer's intent is unclear; offer two or three distinct options when brainstorming. Keep chat replies short and concrete (a few short paragraphs or a tight list). Cite chapters like "(Ch. 9)".
- Ground claims about the book with the search_mckee_book tool when a point is specific or the writer asks "what does McKee say". The book is copyrighted: paraphrase, and quote at most a sentence or two at a time.
- When you have concrete content for the builder, call propose_character_updates. The writer reviews every proposal and applies it with a click, so propose freely but precisely: use exact paths and option ids from the field index, fill empty fields first, and say in "rationale" why each value serves the character. Don't overwrite a filled field unless you are improving it and say so. Never claim that an update was applied — only the writer can apply it.
- Use analyze_character for a McKee diagnostic of the live character (progress, checks, scores) before giving an overall critique.
- Use propose_cast_member to suggest new roles (foils, antagonists, first-circle helpers) that would draw out specific dimensions.
- Each user turn may begin with a <character_snapshot> of the live character and a <focus> naming the station the writer is on. The newest snapshot is the truth; earlier ones are history.
- Write in the writer's language. Never invent facts about the writer's story that contradict the snapshot.

The sixteen stations:
${frameworkSummary()}`;

const FIELD_INDEX_NOTE = 'Lists accept op "append" with one item object; multi-selects accept "set" (whole array) or "append"; everything else uses "set". New list items get ids automatically, but you may set an "id" on a new dimension (e.g. "dim_pride") so other updates in the same proposal can reference it.';

const OPTION_GLOSSARY = `Option glossary:
Circles: ${K.CIRCLES.map((o) => `${o.id}=${o.label}`).join('; ')}
Dimension types: ${K.DIMENSION_TYPES.map((o) => `${o.id}=${o.label}`).join('; ')}
Self levels: ${K.SELF_LEVELS.map((o) => `${o.id}=${o.label}`).join('; ')}
Primary genres: ${K.PRIMARY_GENRES.map((g) => `${g.id}=${g.label} (core value ${g.coreValue}; core cast ${g.coreCast.join('/')})`).join('; ')}
MO themes: ${K.MO_THEMES.map((o) => `${o.id}=${o.label}`).join('; ')}`;

const COACH_SYSTEM = `${COACH_RULES}

Field index (path — label — type). ${FIELD_INDEX_NOTE}
${describeFieldIndex()}

${OPTION_GLOSSARY}`;

// For local models with small context windows: the field index is fetched
// on demand with list_fields instead of riding in every request.
const COACH_SYSTEM_COMPACT = `${COACH_RULES}

Before proposing updates, call list_fields with the station id (${SECTIONS.map((s) => s.id).join(', ')}) to get the exact paths, types and option ids. ${FIELD_INDEX_NOTE}`;

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
    description: 'Propose concrete values for fields of the current character. The writer sees each update with your rationale and applies or dismisses it. Paths and value types must match the field index.',
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

const LIST_FIELDS_TOOL = {
  name: 'list_fields',
  description: 'List the editable field paths, types and option ids of one builder station, for use with propose_character_updates.',
  input_schema: {
    type: 'object',
    properties: { station: { type: 'string', enum: SECTIONS.map((s) => s.id), description: 'Station id.' } },
    required: ['station'],
  },
};

// The tool set for a conversation, fixed by provider. OpenAI-compatible
// services get plain JSON schemas: no Anthropic-only fields, no empty
// parameter objects, and update values as JSON text, which every
// function-calling implementation accepts.
function coachToolsFor(cfg) {
  if (cfg.kind === 'anthropic') return COACH_TOOLS;
  const tools = structuredClone(COACH_TOOLS).map(({ eager_input_streaming, ...t }) => t); // eslint-disable-line no-unused-vars
  tools.find((t) => t.name === 'analyze_character').input_schema = {
    type: 'object',
    properties: { focus: { type: 'string', description: 'Optional station id to focus the checks on, e.g. "dimensions".' } },
  };
  tools.find((t) => t.name === 'propose_character_updates').input_schema.properties.updates.items.properties.value = {
    type: 'string',
    description: 'The value as JSON: "quoted text", 7, true, ["option_id", …] or an object such as {"positive":"Proud","negative":"Ashamed"} for a list item. Plain text is fine for text fields.',
  };
  if (cfg.compactPrompt) tools.push(LIST_FIELDS_TOOL);
  return tools;
}

// Values that arrive as JSON text (OpenAI-compatible tools) become real values.
function parseLoose(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (/^(\{|\[|"|-?\d|true$|false$|null$)/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

// When the writer's interface language changes (or isn't English from the
// start), the next user turn says so. The system prompt stays fixed.
function languageBlock(lang, mode) {
  if (lang === 'it') {
    if (mode === 'interview') return '<interface_language>The writer uses CharBuild in Italian. Stay in character and speak Italian (italiano), in your own voice.</interface_language>';
    const stations = SECTIONS.map((s) => `${s.num} ${tr('it', s.title)}`).join('; ');
    return `<interface_language>The writer uses CharBuild in Italian. Write every reply in Italian (italiano), including the text values you propose for fields and every summary and rationale; paths and option ids stay exactly as in the field index. Call the stations by their Italian names: ${stations}. The book is the original English edition: search it with English keywords, and translate or paraphrase what you cite into Italian, giving the chapter as "(Cap. N)".</interface_language>`;
  }
  return mode === 'interview'
    ? '<interface_language>The writer now uses CharBuild in English. Stay in character and speak English.</interface_language>'
    : '<interface_language>The writer now uses CharBuild in English. Reply in English and use the station names from the framework above.</interface_language>';
}

const SearchInput = z.object({ query: z.string().min(1).max(300), max_results: z.number().int().min(1).max(8).optional() });
const ProposeInput = z.object({
  summary: z.string().max(500),
  updates: z.array(z.object({ path: z.string(), op: z.enum(['set', 'append']).optional(), value: z.any(), rationale: z.string().max(1500).optional() })).min(1).max(24),
});
const ListFieldsInput = z.object({ station: z.enum(SECTIONS.map((s) => s.id)) });
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
  const providerCfg = (id) => resolveProvider(store.settings, id);
  const activeCfg = () => providerCfg(activeProviderId(store.settings));
  const clientFor = (cfg) => {
    if (makeClient) return makeClient(cfg);
    return cfg.kind === 'anthropic' ? createAnthropicClient(cfg) : createOpenAIClient(cfg);
  };
  const autoModels = new Map(); // provider+baseURL → model picked from its /models list

  function status(lang) {
    const a = activeCfg();
    return {
      provider: a.id,
      providerLabel: a.label,
      configured: a.configured,
      source: a.source,
      keyHint: a.keyHint,
      model: a.model || autoModels.get(`${a.id}|${a.baseURL}`) || '',
      effort: a.effort,
      reasoningEffort: a.reasoningEffort,
      baseURL: a.baseURL,
      providers: PROVIDERS.map((d) => publicProvider(providerCfg(d.id))),
      book: bookStatus(rootDir, lang),
    };
  }

  async function updateSettings(body = {}) {
    const { provider, providerId, apiKey, clearKey, model, baseURL, effort, reasoningEffort } = body;
    if (provider != null && !PROVIDER_BY_ID[provider]) throw i18nError(400, 'Unknown AI provider “{id}”', { id: provider });
    const id = providerId || provider || activeProviderId(store.settings);
    if (!PROVIDER_BY_ID[id]) throw i18nError(400, 'Unknown AI provider “{id}”', { id });

    const providers = structuredClone(store.settings.providers || {});
    const patch = {};
    // Older versions kept Claude's settings at the top level; move them.
    if (store.settings.apiKey || store.settings.model || store.settings.effort) {
      providers.anthropic = { apiKey: store.settings.apiKey, model: store.settings.model, effort: store.settings.effort, ...(providers.anthropic || {}) };
      Object.assign(patch, { apiKey: null, model: null, effort: null });
    }
    const cur = { ...(providers[id] || {}) };
    if (clearKey) delete cur.apiKey;
    else if (typeof apiKey === 'string' && apiKey.trim()) cur.apiKey = apiKey.trim();
    if (typeof model === 'string') {
      if (model.trim()) cur.model = model.trim().slice(0, 200);
      else delete cur.model;
    }
    if (typeof baseURL === 'string') {
      const b = baseURL.trim();
      if (b && !/^https?:\/\/[^\s]+$/i.test(b)) throw i18nError(400, 'Base URL must start with http:// or https://');
      if (b) cur.baseURL = b;
      else delete cur.baseURL;
    }
    if (typeof effort === 'string') {
      if (ANTHROPIC_EFFORTS.includes(effort)) cur.effort = effort;
      else delete cur.effort;
    }
    if (typeof reasoningEffort === 'string') {
      if (REASONING_EFFORTS.includes(reasoningEffort)) cur.reasoningEffort = reasoningEffort;
      else delete cur.reasoningEffort;
    }
    for (const k of Object.keys(cur)) if (cur[k] == null || cur[k] === '') delete cur[k];
    if (Object.keys(cur).length) providers[id] = cur;
    else delete providers[id];
    patch.providers = providers;
    if (provider) patch.provider = provider;
    await store.saveSettings(patch);
    autoModels.clear();
    return status();
  }

  function requireConfigured(cfg) {
    if (cfg.configured) return;
    throw cfg.needsKey
      ? i18nError(400, '{provider} has no API key yet. Add one in the coach settings (or set {env}).', { provider: cfg.label, env: `${cfg.envPrefix}_API_KEY` })
      : i18nError(400, '{provider} needs a base URL. Set it in the coach settings.', { provider: cfg.label });
  }

  async function listModels(id) {
    const cfg = providerCfg(id || activeProviderId(store.settings));
    requireConfigured(cfg);
    try {
      const client = clientFor(cfg);
      return cfg.kind === 'anthropic' ? await listAnthropicModels(client) : await listOpenAIModels(client);
    } catch (err) {
      err.provider = cfg;
      throw err;
    }
  }

  async function test(id, lang = DEFAULT_LOCALE) {
    const cfg = providerCfg(id || activeProviderId(store.settings));
    const label = tr(lang, cfg.label);
    if (!cfg.configured) return { ok: false, error: cfg.needsKey ? tr(lang, '{provider} has no API key yet.', { provider: label }) : tr(lang, '{provider} needs a base URL.', { provider: label }) };
    try {
      const client = clientFor(cfg);
      if (cfg.kind === 'anthropic') return { ...(await testAnthropic(client, cfg)), provider: cfg.label };
      const ids = await listOpenAIModels(client);
      if (!cfg.model) {
        const pick = pickChatModel(ids);
        return pick
          ? { ok: true, provider: cfg.label, model: pick, name: `${pick} (auto)`, count: ids.length }
          : { ok: false, provider: cfg.label, error: tr(lang, '{provider} answered but lists no models. Install or load one first.', { provider: label }) };
      }
      const listed = !ids.length || ids.includes(cfg.model);
      return {
        ok: true,
        provider: cfg.label,
        model: cfg.model,
        name: cfg.model,
        count: ids.length,
        warning: listed ? undefined : tr(lang, '“{model}” isn’t in {provider}’s model list ({n} models). Use Load models to pick one.', { model: cfg.model, provider: label, n: ids.length }),
      };
    } catch (err) {
      err.provider = cfg;
      throw err;
    }
  }

  async function withModel(cfg, client, emit, lang = DEFAULT_LOCALE) {
    if (cfg.model) return cfg;
    const key = `${cfg.id}|${cfg.baseURL}`;
    let model = autoModels.get(key);
    if (!model) {
      const ids = cfg.kind === 'anthropic' ? await listAnthropicModels(client) : await listOpenAIModels(client);
      model = pickChatModel(ids);
      if (!model) throw i18nError(400, '{provider} lists no models. Install or load one, or set a model in the coach settings.', { provider: cfg.label });
      autoModels.set(key, model);
      emit('notice', { message: tr(lang, 'Using {provider} model “{model}”.', { provider: tr(lang, cfg.label), model }) });
    }
    return { ...cfg, model };
  }

  function contextFor(characterId) {
    const character = store.getCharacter(characterId);
    const story = character.storyId ? store.data.stories.find((s) => s.id === character.storyId) : null;
    const cast = character.storyId ? store.listCharacters(character.storyId) : [character];
    return { character, story, cast };
  }

  async function runTool(name, input, chat, emit, opts = {}) {
    switch (name) {
      case 'search_mckee_book': {
        const parsed = SearchInput.safeParse(input);
        if (!parsed.success) return { error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(input) }) };
        const lang = chat.lang || DEFAULT_LOCALE;
        const res = searchBook(rootDir, parsed.data.query, parsed.data.max_results || 4, 1400, lang);
        emit('tool', { name, query: parsed.data.query, label: tr(lang, 'Searched the book: “{query}”', { query: parsed.data.query }), results: res.results?.map((r) => ({ chapter: r.chapter, section: r.section })) });
        if (!res.available) return { content: `The book is not available (${res.reason}). Rely on the framework summary instead and say so.` };
        if (!res.results.length) return { content: 'No passages matched. Try different keywords.' };
        return { content: res.results.map((r, i) => `[${i + 1}] ${r.chapter}${r.section ? ` · ${r.section}` : ''}\n${r.text}`).join('\n\n') };
      }
      case 'analyze_character': {
        const { character, story, cast } = contextFor(chat.characterId);
        const progress = overallProgress(character, story);
        const ap = antagonismProfile(character);
        const td = traitDensity(character);
        const focus = SECTION_BY_ID[input?.focus] ? input.focus : null;
        const checks = characterChecks(character, story, cast).filter((c) => !focus || c.section === focus);
        emit('tool', { name, label: tr(chat.lang || DEFAULT_LOCALE, 'Ran the McKee diagnostics') });
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
      case 'list_fields': {
        const parsed = ListFieldsInput.safeParse(input);
        if (!parsed.success) return { error: true, content: `station must be one of: ${SECTIONS.map((s) => s.id).join(', ')}` };
        return { content: describeFieldIndex(parsed.data.station) };
      }
      case 'propose_character_updates': {
        const parsed = ProposeInput.safeParse(input);
        if (!parsed.success) return { error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(input) }) };
        const updates = opts.looseValues ? parsed.data.updates.map((u) => ({ ...u, value: parseLoose(u.value) })) : parsed.data.updates;
        const { character, cast } = contextFor(chat.characterId);
        const ctx = updateContext(character, cast, updates);
        const accepted = [];
        const rejected = [];
        for (const u of updates) {
          const r = validateUpdate(u, ctx);
          if (r.ok) accepted.push({ ...r.update, rationale: u.rationale || '' });
          else rejected.push(r.error);
        }
        if (accepted.length) {
          const proposal = { id: uid('prop'), kind: 'updates', characterId: chat.characterId, summary: parsed.data.summary, updates: accepted, status: 'pending' };
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
        emit('proposal', proposal);
        return { content: `Suggested ${parsed.data.name} to the writer as a ${parsed.data.circle}-circle role. Not added until the writer accepts.` };
      }
      default:
        return { error: true, content: `Unknown tool ${name}` };
    }
  }

  // Text blocks prepended to the user's message: the character snapshot
  // when it changed since the last turn, and the station in focus.
  function contextBlocks(chat, section, lang) {
    const { character, story, cast } = contextFor(chat.characterId);
    const digest = characterDigest(character, story, cast);
    const hash = crypto.createHash('sha1').update(digest).digest('hex');
    const blocks = [];
    if ((chat.lang || DEFAULT_LOCALE) !== lang) {
      chat.lang = lang;
      blocks.push(languageBlock(lang, chat.mode));
    }
    if (hash !== chat.snapshotHash) {
      chat.snapshotHash = hash;
      blocks.push(chat.mode === 'interview' ? `<dossier>\n${digest}\n</dossier>` : `<character_snapshot>\n${digest}\n</character_snapshot>`);
    }
    if (chat.mode === 'coach' && section && SECTION_BY_ID[section]) {
      const s = SECTION_BY_ID[section];
      blocks.push(`<focus>The writer is on station ${s.num} “${s.title}” (Ch. ${s.chapters.join(', ')}).</focus>`);
    }
    return blocks;
  }

  async function getOrCreateChat({ conversationId, mode, characterId, lang }) {
    if (conversationId) {
      const chat = await store.loadChat(conversationId);
      if (!chat) throw i18nError(404, 'Conversation not found');
      chat.provider = chat.provider || 'anthropic'; // conversations from before multi-provider support
      return chat;
    }
    const character = store.getCharacter(characterId);
    const now = new Date().toISOString();
    return {
      id: uid('chat'),
      mode,
      provider: activeProviderId(store.settings),
      characterId,
      storyId: character.storyId,
      title: mode === 'interview' ? tr(lang, 'Interview with {name}', { name: displayName(character) }) : tr(lang, 'Coaching {name}', { name: displayName(character) }),
      createdAt: now,
      updatedAt: now,
      messages: [],
      display: [],
      snapshotHash: null,
    };
  }

  // Runs one user turn; emits SSE events through `emit(type, data)`.
  async function chat({ conversationId, mode = 'coach', characterId, message, section, lang = DEFAULT_LOCALE }, emit, signal) {
    if (!['coach', 'interview'].includes(mode)) throw i18nError(400, 'Unknown mode');
    const text = String(message || '').trim();
    if (!text) throw i18nError(400, 'Empty message');
    if (text.length > 20000) throw i18nError(400, 'Message too long');
    const chat = await getOrCreateChat({ conversationId, mode, characterId, lang });
    // A conversation stays with the provider it started on: message formats
    // (and thinking blocks) aren't portable between APIs.
    let cfg = providerCfg(chat.provider);
    emit('conversation', { id: chat.id, mode: chat.mode, title: chat.title, provider: cfg.id, providerLabel: cfg.label });
    const display = { role: 'assistant', text: '', thinking: '', tools: [], proposals: [], notices: [], provider: cfg.id };
    const tracked = (type, data) => {
      if (type === 'text') display.text += data.delta;
      else if (type === 'thinking') display.thinking += data.delta;
      else if (type === 'tool') display.tools.push(data);
      else if (type === 'proposal') display.proposals.push(data);
      else if (type === 'notice') display.notices.push(data.message);
      emit(type, data);
    };
    const active = activeProviderId(store.settings);
    if (conversationId && chat.provider !== active) {
      tracked('notice', { message: tr(lang, 'This conversation runs on {provider}. Start a new conversation to use {active}.', { provider: tr(lang, cfg.label), active: tr(lang, PROVIDER_BY_ID[active].label) }) });
    }

    const prevHash = chat.snapshotHash;
    const prevLang = chat.lang;
    let result;
    try {
      requireConfigured(cfg);
      const client = clientFor(cfg);
      cfg = await withModel(cfg, client, tracked, lang);
      display.model = cfg.model;
      const userBlocks = [...contextBlocks(chat, section, lang), text];
      const system = mode === 'interview' ? INTERVIEW_SYSTEM : cfg.compactPrompt ? COACH_SYSTEM_COMPACT : COACH_SYSTEM;
      const run = cfg.kind === 'anthropic' ? runAnthropicTurn : runOpenAITurn;
      result = await run({
        client,
        cfg,
        system,
        history: chat.messages,
        userBlocks,
        tools: mode === 'coach' ? coachToolsFor(cfg) : null,
        runTool: (name, input, opts) => runTool(name, input, chat, tracked, opts),
        emit: tracked,
        signal,
        maxIterations: MAX_ITERATIONS,
        say: (key, vars) => tr(lang, key, vars),
      });
    } catch (err) {
      chat.snapshotHash = prevHash; // nothing from this turn is kept
      chat.lang = prevLang;
      err.provider = err.provider || cfg;
      throw err;
    }

    // The turn completed: append it (never rewrite earlier history). If the
    // iteration cap left tool results unanswered, close with a short note.
    const turn = result.messages;
    if (turn[turn.length - 1].role !== 'assistant') {
      turn.push((cfg.kind === 'anthropic' ? anthropicClosing : openaiClosing)('(Paused after several tool rounds.)'));
    }
    chat.messages.push(...turn);
    chat.model = cfg.model;
    chat.display.push({ role: 'user', text, section: section || null, at: new Date().toISOString() });
    chat.display.push({ ...display, at: new Date().toISOString() });
    chat.updatedAt = new Date().toISOString();
    await store.saveChat(chat);
    emit('done', { stopReason: result.stopReason, conversationId: chat.id });
    return chat;
  }

  async function setProposalStatus(conversationId, proposalId, statusValue) {
    const chat = await store.loadChat(conversationId);
    if (!chat) throw i18nError(404, 'Conversation not found');
    for (const d of chat.display) for (const p of d.proposals || []) if (p.id === proposalId) p.status = statusValue;
    await store.saveChat(chat);
    return { ok: true };
  }

  return { status, test, listModels, updateSettings, chat, setProposalStatus };
}

export function publicChat(chat) {
  if (!chat) return null;
  const { messages, snapshotHash, ...rest } = chat;
  return { ...rest, provider: rest.provider || 'anthropic' };
}
