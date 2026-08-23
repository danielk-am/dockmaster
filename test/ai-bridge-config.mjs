import assert from 'node:assert/strict';
import { aiChatClientConfig, createAiBridgeRegistry } from '../server/ai-bridge-config.mjs';

const keys = {
  AI_CHAT_CLAUDE_API_KEY: 'claude-secret',
  AI_CHAT_GEMINI_API_KEY: 'gemini-secret',
  AI_CHAT_CHATGPT_API_KEY: 'chatgpt-secret',
};
const registry = createAiBridgeRegistry(keys);
const config = aiChatClientConfig(registry);

assert.deepEqual(config.bridges.map(({ provider }) => provider), ['claude', 'gemini', 'chatgpt']);
assert.deepEqual(config.bridges.map(({ providerLabel }) => providerLabel), [
  'Claude-a8c · Anthropic Claude',
  'Gemini-a8c · Google Gemini',
  'ChatGPT-a8c · OpenAI',
]);
assert.equal(config.bridges[0].endpoint, '/api/ai/v1/bridges/claude/chat/completions');
assert.equal(config.bridges[0].models[0].supportsImages, false);
assert.equal(config.bridges[1].models[0].supportsImages, true);
assert.equal(JSON.stringify(config).includes('secret'), false);

const legacy = aiChatClientConfig(createAiBridgeRegistry({
  AI_CHAT_PROVIDER: 'gemini',
  AI_CHAT_UPSTREAM_URL: 'http://127.0.0.1:8790/v1/chat/completions',
  AI_CHAT_API_KEY: 'legacy-secret',
  AI_CHAT_CLIENT_ID: 'host-a8c',
  AI_CHAT_MODELS: 'gemini-3.6-flash',
}));
assert.deepEqual(legacy.bridges.map(({ provider }) => provider), ['gemini']);

assert.throws(
  () => createAiBridgeRegistry({ AI_CHAT_PROVIDER: 'unknown', AI_CHAT_API_KEY: 'secret' }),
  /AI_CHAT_PROVIDER/
);
assert.throws(
  () => createAiBridgeRegistry({ AI_CHAT_CLAUDE_MODELS: 'claude-sonnet' }),
  /AI_CHAT_CLAUDE_API_KEY/
);

console.log('ai bridge config tests: ok');
