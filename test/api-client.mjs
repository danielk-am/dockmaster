import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let apiGet;
try {
  ({ apiGet } = await import('../src/api.mjs'));
} catch {
  // The first TDD run intentionally reaches this branch before the helper exists.
}

assert.equal(typeof apiGet, 'function', 'apiGet should be exported');

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ value: 42 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  assert.deepEqual(await apiGet('example'), { value: 42 });

  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Provider unavailable.' }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  });
  await assert.rejects(apiGet('example'), /Provider unavailable\./);
} finally {
  globalThis.fetch = originalFetch;
}

const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
assert.match(appSource, /import \{ apiGet \} from '\.\/api\.mjs';/);
assert.match(appSource, /apiGet\(path\)\.then\(setData\)/);

console.log('API client error handling passed');
