import { createOpenAICompatibleRelay } from '@1dr0/ai-chat/server';

const PROVIDERS = [
  {
    id: 'claude',
    providerLabel: 'Claude-a8c · Anthropic Claude',
    upstreamUrl: 'http://127.0.0.1:8789/v1/chat/completions',
    models: ['claude-sonnet', 'claude-opus', 'claude-fable'],
    supportsImages: false,
  },
  {
    id: 'gemini',
    providerLabel: 'Gemini-a8c · Google Gemini',
    upstreamUrl: 'http://127.0.0.1:8790/v1/chat/completions',
    models: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-pro-preview'],
    supportsImages: true,
  },
  {
    id: 'chatgpt',
    providerLabel: 'ChatGPT-a8c · OpenAI',
    upstreamUrl: 'http://127.0.0.1:8791/v1/chat/completions',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    supportsImages: true,
  },
];

const PROVIDER_IDS = new Set(PROVIDERS.map(({ id }) => id));
const text = (value) => String(value || '').trim();
const modelsFrom = (value, fallback = []) => {
  const models = text(value).split(',').map((model) => model.trim()).filter(Boolean);
  return models.length ? models : fallback;
};
const modelWords = (value) => value
  .split('-')
  .map((word) => word ? `${word[0].toUpperCase()}${word.slice(1)}` : '')
  .join(' ');
const modelLabel = (id) => id.startsWith('gemini-')
  ? `Gemini ${modelWords(id.slice(7))}`
  : id.startsWith('gpt-')
    ? `GPT-${modelWords(id.slice(4))}`
    : id.startsWith('claude-')
      ? `Claude ${modelWords(id.slice(7))}`
      : modelWords(id);

function legacyProvider(env, legacyModels) {
  const inferred = legacyModels[0]?.startsWith('claude')
    ? 'claude'
    : legacyModels[0]?.startsWith('gpt-')
      ? 'chatgpt'
      : 'gemini';
  const provider = text(env.AI_CHAT_PROVIDER) || inferred;
  if (!PROVIDER_IDS.has(provider)) {
    throw new Error('AI_CHAT_PROVIDER must be claude, gemini, or chatgpt.');
  }
  return provider;
}

export function createAiBridgeRegistry(env = process.env) {
  const legacyModels = modelsFrom(env.AI_CHAT_MODELS);
  const legacyConfigured = [
    env.AI_CHAT_UPSTREAM_URL,
    env.AI_CHAT_API_KEY,
    env.AI_CHAT_MODELS,
    env.AI_CHAT_PROVIDER,
  ].some((value) => text(value));
  const selectedLegacyProvider = legacyConfigured ? legacyProvider(env, legacyModels) : null;
  const relays = new Map();

  for (const definition of PROVIDERS) {
    const prefix = `AI_CHAT_${definition.id.toUpperCase()}`;
    const providerConfigured = [
      env[`${prefix}_UPSTREAM_URL`],
      env[`${prefix}_API_KEY`],
      env[`${prefix}_CLIENT_ID`],
      env[`${prefix}_MODELS`],
    ].some((value) => text(value));
    const usesLegacy = legacyConfigured && selectedLegacyProvider === definition.id;
    if (!providerConfigured && !usesLegacy) continue;

    const apiKey = text(env[`${prefix}_API_KEY`]) || (usesLegacy ? text(env.AI_CHAT_API_KEY) : '');
    if (!apiKey) {
      throw new Error(`${prefix}_API_KEY is required when the ${definition.id} bridge is configured.`);
    }
    const upstreamUrl = text(env[`${prefix}_UPSTREAM_URL`])
      || (usesLegacy ? text(env.AI_CHAT_UPSTREAM_URL) : '')
      || definition.upstreamUrl;
    const clientId = text(env[`${prefix}_CLIENT_ID`]) || text(env.AI_CHAT_CLIENT_ID) || 'host-a8c';
    const models = modelsFrom(
      env[`${prefix}_MODELS`] || (usesLegacy ? env.AI_CHAT_MODELS : ''),
      definition.models
    );
    const relay = createOpenAICompatibleRelay({ upstreamUrl, apiKey, clientId, models });
    relays.set(definition.id, {
      relay,
      publicConfig: {
        provider: definition.id,
        providerLabel: definition.providerLabel,
        endpoint: `/api/ai/v1/bridges/${definition.id}/chat/completions`,
        model: models[0],
        models: models.map((id) => ({
          id,
          label: modelLabel(id),
          supportsImages: definition.supportsImages,
        })),
      },
    });
  }

  return relays;
}

export function aiChatClientConfig(relays) {
  return relays.size
    ? {
        mode: 'bridge',
        bridges: [...relays.values()].map(({ publicConfig }) => publicConfig),
      }
    : { mode: 'direct' };
}
