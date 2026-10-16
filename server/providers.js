// AI providers for the coach. Claude uses the Anthropic SDK natively; every
// other service is reached through the OpenAI Chat Completions API, which
// OpenAI itself and many others (Gemini, OpenRouter, Mistral, Groq,
// DeepSeek, xAI, Ollama, LM Studio…) speak.
//
// Per provider: API key, base URL, model and effort come from the in-app
// settings first, then from environment variables (<PREFIX>_API_KEY,
// <PREFIX>_BASE_URL, <PREFIX>_MODEL), then from the defaults below.

const p = (id, label, fields) => ({
  id,
  label,
  kind: 'openai',
  group: 'cloud',
  needsKey: true,
  baseURL: '',
  defaultModel: '',
  suggestions: [],
  note: '',
  keyUrl: '',
  envPrefix: id.toUpperCase(),
  keyEnvAliases: [],
  compactPrompt: false,
  ...fields,
});

export const PROVIDERS = [
  p('anthropic', 'Anthropic Claude', {
    kind: 'anthropic',
    defaultModel: 'claude-opus-5-5',
    suggestions: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    note: 'Native Anthropic SDK: adaptive thinking, refusal fallbacks and prompt caching.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  }),
  p('openai', 'OpenAI', {
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6.1-sol',
    suggestions: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'],
    keyUrl: 'https://platform.openai.com/api-keys',
  }),
  p('gemini', 'Google Gemini', {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-3.8-flash',
    suggestions: ['gemini-3.8-flash'],
    note: 'Through Google’s OpenAI-compatible endpoint.',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyEnvAliases: ['GOOGLE_API_KEY'],
  }),
  p('openrouter', 'OpenRouter', {
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    suggestions: ['openrouter/auto'],
    note: 'One key for hundreds of models (“openai/…”, “anthropic/…”, “google/…”). Use Load models to browse.',
    keyUrl: 'https://openrouter.ai/keys',
  }),
  p('mistral', 'Mistral', {
    baseURL: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    suggestions: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
  }),
  p('groq', 'Groq', {
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    suggestions: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    keyUrl: 'https://console.groq.com/keys',
  }),
  p('deepseek', 'DeepSeek', {
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    suggestions: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  }),
  p('xai', 'xAI Grok', {
    baseURL: 'https://api.x.ai/v1',
    note: 'Leave the model empty to use the first one your key can access, or pick one with Load models.',
    keyUrl: 'https://console.x.ai',
  }),
  p('ollama', 'Ollama (local)', {
    group: 'local',
    needsKey: false,
    baseURL: 'http://localhost:11434/v1',
    note: 'Runs on the computer hosting CharBuild. Leave the model empty to use the first installed one. Coaching needs a tool-capable model (e.g. qwen3, llama3.1) and a context window of 16k+ tokens.',
    compactPrompt: true,
  }),
  p('lmstudio', 'LM Studio (local)', {
    group: 'local',
    needsKey: false,
    baseURL: 'http://localhost:1234/v1',
    note: 'Start LM Studio’s local server on the CharBuild host. Leave the model empty to use the loaded one.',
    compactPrompt: true,
  }),
  p('custom', 'Custom (OpenAI-compatible)', {
    group: 'other',
    needsKey: false,
    note: 'Any server that implements the OpenAI Chat Completions API — set its base URL (ending in /v1), model and, if required, a key.',
    envPrefix: 'CUSTOM_LLM',
  }),
];

export const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map((x) => [x.id, x]));
export const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];

const keyHint = (key) => (key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null);

function envKey(def) {
  for (const name of [`${def.envPrefix}_API_KEY`, ...def.keyEnvAliases]) {
    if (process.env[name]) return { value: process.env[name], name };
  }
  return null;
}

// Saved settings for one provider. Older versions stored Claude's key,
// model and effort at the top level; read those as Anthropic's.
function savedFor(settings, id) {
  const saved = { ...(settings.providers?.[id] || {}) };
  if (id === 'anthropic') {
    for (const k of ['apiKey', 'model', 'effort']) if (saved[k] == null && settings[k]) saved[k] = settings[k];
  }
  return saved;
}

export function resolveProvider(settings, id) {
  const def = PROVIDER_BY_ID[id];
  if (!def) throw Object.assign(new Error(`Unknown AI provider "${id}"`), { status: 400 });
  const saved = savedFor(settings, id);
  const env = envKey(def);
  const apiKey = saved.apiKey || env?.value || '';
  let source = saved.apiKey ? 'settings' : env ? `env (${env.name})` : 'none';
  if (id === 'anthropic' && source === 'none' && process.env.ANTHROPIC_AUTH_TOKEN) source = 'env (ANTHROPIC_AUTH_TOKEN)';
  const baseURL = def.kind === 'anthropic' ? '' : (saved.baseURL || process.env[`${def.envPrefix}_BASE_URL`] || def.baseURL || '').trim();
  const model = (saved.model || process.env[`${def.envPrefix}_MODEL`] || def.defaultModel || '').trim();
  const configured = def.needsKey ? source !== 'none' : !!baseURL;
  return {
    ...def,
    apiKey,
    source,
    keyHint: keyHint(apiKey),
    baseURL,
    defaultBaseURL: def.baseURL,
    model,
    effort: ANTHROPIC_EFFORTS.includes(saved.effort) ? saved.effort : 'medium',
    reasoningEffort: REASONING_EFFORTS.includes(saved.reasoningEffort) ? saved.reasoningEffort : '',
    configured,
  };
}

// The provider used for new conversations: the one chosen in settings,
// else AI_PROVIDER, else the first provider with a key in the environment.
export function activeProviderId(settings) {
  if (PROVIDER_BY_ID[settings.provider]) return settings.provider;
  if (PROVIDER_BY_ID[process.env.AI_PROVIDER]) return process.env.AI_PROVIDER;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'anthropic';
  const withKey = PROVIDERS.find((d) => d.needsKey && envKey(d));
  return withKey ? withKey.id : 'anthropic';
}

// What the browser may see (never the key itself).
export function publicProvider(cfg) {
  const { apiKey, envPrefix, keyEnvAliases, ...rest } = cfg;
  return { ...rest, keyEnv: [`${envPrefix}_API_KEY`, ...keyEnvAliases] };
}

// Skip embedding/audio/image models when picking a default chat model.
export function pickChatModel(ids) {
  const skip = /embed|whisper|tts|dall-?e|image|imagen|moderation|audio|realtime|transcribe|speech|guard|rerank|ocr|vision-preview/i;
  return ids.find((id) => !skip.test(id)) || ids[0] || '';
}
