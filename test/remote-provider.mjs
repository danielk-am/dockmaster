import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RemoteProviderError,
  createRemoteProvider,
  remoteProviderOptionsFromEnvironment,
} from '../server/remote-provider-lib.mjs';

const allowlist = {
  'provider-demo': {
    web: ['start', 'stop', 'restart', 'pull'],
    worker: ['start', 'stop'],
  },
  'mcp-fs-bridge': {
    'mcp-fs-bridge': ['start'],
  },
};

const port = {
  container: '80/tcp',
  host_ip: '127.0.0.1',
  host_port: '8080',
  secret: 'drop-me',
};

const container = {
  id: 'abc123def456',
  container: 'demo-web-1',
  image: 'example/web:1.2.3',
  state: 'running',
  health: 'healthy',
  ports: [port],
  environment: ['TOKEN=must-not-escape'],
};

const service = {
  name: 'web',
  state: 'mixed',
  health: 'mixed',
  image: 'example/web:1.2.3',
  ports: [port],
  containers: [container],
  actions: ['pull', 'delete', 'start', 'restart', 'stop'],
  internal_port: 80,
  health_path: '/health',
  owner: 'Daniel',
  environment: ['TOKEN=must-not-escape'],
};

const inventoryWireResponse = {
  schema: 'dockmaster-provider-inventory/v1',
  generated_at: '2026-08-02T09:30:00.000Z',
  projects: [
    {
      id: 'provider-demo',
      project: 'compose-demo',
      owner: 'Daniel',
      route: { hostname: 'demo.internal', entrypoint: 'http', service: 'web', secret: 'drop-me' },
      services: [service],
      compose_path: '/secret/compose.yaml',
    },
  ],
  raw: 'drop-me',
};

const normalizedService = {
  name: 'web',
  state: 'mixed',
  health: 'mixed',
  image: 'example/web:1.2.3',
  ports: [{ containerPort: 80, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 8080 }],
  containers: [
    {
      id: 'abc123def456',
      container: 'demo-web-1',
      image: 'example/web:1.2.3',
      state: 'running',
      health: 'healthy',
      ports: [{ containerPort: 80, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 8080 }],
    },
  ],
  actions: ['start', 'stop', 'restart', 'pull'],
  internalPort: 80,
  healthPath: '/health',
  owner: 'Daniel',
};

const calls = [];
const queued = [];
const fakeExecFile = (file, args, options, callback) => {
  calls.push({ file, args, options });
  const next = queued.shift();
  queueMicrotask(() => callback(next?.error || null, next?.stdout || '', next?.stderr || ''));
  return { pid: 1234 };
};

const enqueueJson = (value, stderr = '') => queued.push({ stdout: JSON.stringify(value), stderr });
const enqueueFailure = (stderr) => queued.push({ error: Object.assign(new Error('ssh failed'), { code: 255 }), stderr });

const config = Object.freeze({
  sshPath: '/usr/bin/ssh',
  host: 'provider.example',
  user: 'dockmaster-provider',
  identityFile: '/var/lib/dockmaster/keys/provider',
});
const provider = createRemoteProvider({ allowlist, config, execFileImpl: fakeExecFile });

assert.equal(remoteProviderOptionsFromEnvironment({}), null);
assert.deepEqual(remoteProviderOptionsFromEnvironment({
  DOCKMASTER_REMOTE_PROVIDER_HOST: config.host,
  DOCKMASTER_REMOTE_PROVIDER_IDENTITY_FILE: config.identityFile,
  DOCKMASTER_REMOTE_PROVIDER_ALLOWLIST: JSON.stringify(allowlist),
}), { config, allowlist });
assert.throws(
  () => remoteProviderOptionsFromEnvironment({ DOCKMASTER_REMOTE_PROVIDER_HOST: config.host }),
  (error) => error instanceof RemoteProviderError && error.code === 'INVALID_CONFIG',
);
assert.throws(
  () => remoteProviderOptionsFromEnvironment({
    DOCKMASTER_REMOTE_PROVIDER_HOST: config.host,
    DOCKMASTER_REMOTE_PROVIDER_IDENTITY_FILE: config.identityFile,
    DOCKMASTER_REMOTE_PROVIDER_ALLOWLIST: '{bad json',
  }),
  (error) => error instanceof RemoteProviderError && error.code === 'INVALID_CONFIG',
);

for (const badConfig of [
  { ...config, sshPath: '/bin/sh' },
  { ...config, host: 'other host' },
  { ...config, user: 'root' },
  { ...config, identityFile: '/tmp/key' },
  { ...config, extra: true },
]) {
  assert.throws(
    () => createRemoteProvider({ allowlist, execFileImpl: fakeExecFile, config: badConfig }),
    (error) => error instanceof RemoteProviderError && error.code === 'INVALID_CONFIG',
  );
}

enqueueJson(inventoryWireResponse, 'warning containing a credential that must not be returned');
assert.deepEqual(await provider.request({ action: 'inventory' }), {
  ok: true,
  action: 'inventory',
  schema: 'dockmaster-provider-inventory/v1',
  generatedAt: '2026-08-02T09:30:00.000Z',
  projects: [
    {
      id: 'provider-demo',
      project: 'compose-demo',
      owner: 'Daniel',
      route: { hostname: 'demo.internal', entrypoint: 'http', service: 'web' },
      services: [normalizedService],
    },
  ],
});

assert.equal(calls[0].file, '/usr/bin/ssh');
assert.deepEqual(calls[0].args, [
  '-T',
  '-o', 'BatchMode=yes',
  '-o', 'ClearAllForwardings=yes',
  '-o', 'ForwardAgent=no',
  '-o', 'PermitLocalCommand=no',
  '-o', 'ConnectTimeout=5',
  '-i', '/var/lib/dockmaster/keys/provider',
  '-l', 'dockmaster-provider',
  '--', 'provider.example',
  'dockmaster-provider', 'inventory',
]);
assert.equal(calls[0].options.shell, false);
assert.equal(calls[0].options.timeout, 8_000);
assert.equal(calls[0].options.maxBuffer, 1024 * 1024);

enqueueJson({
  records: [
    {
      request_id: 'req-start',
      timestamp: '2026-08-02T09:31:00.000Z',
      actor: 'dockmaster-provider',
      action: 'start',
      target: 'provider-demo/web',
      result: 'ok',
      rollback: 'never expose this',
      environment: 'drop-me',
    },
    {
      request_id: 'req-routes-apply',
      timestamp: '2026-08-02T09:32:00.000Z',
      actor: 'dockmaster-provider',
      action: 'routes-apply',
      target: '/etc/traefik/dynamic/dockmaster-managed.yaml',
      result: 'ok',
      routers: ['dockmaster-demo'],
    },
    {
      request_id: 'req-routes-remove',
      timestamp: '2026-08-02T09:33:00.000Z',
      actor: 'dockmaster-provider',
      action: 'routes-remove',
      target: '/etc/traefik/dynamic/dockmaster-managed.yaml',
      result: 'ok',
      removed: true,
    },
  ],
  raw_log: 'drop-me',
});
assert.deepEqual(await provider.request({ action: 'audit' }), {
  ok: true,
  action: 'audit',
  records: [
    {
      requestId: 'req-start',
      timestamp: '2026-08-02T09:31:00.000Z',
      actor: 'dockmaster-provider',
      action: 'start',
      target: 'provider-demo/web',
      result: 'ok',
    },
    {
      requestId: 'req-routes-apply',
      timestamp: '2026-08-02T09:32:00.000Z',
      actor: 'dockmaster-provider',
      action: 'routes-apply',
      target: '/etc/traefik/dynamic/dockmaster-managed.yaml',
      result: 'ok',
    },
    {
      requestId: 'req-routes-remove',
      timestamp: '2026-08-02T09:33:00.000Z',
      actor: 'dockmaster-provider',
      action: 'routes-remove',
      target: '/etc/traefik/dynamic/dockmaster-managed.yaml',
      result: 'ok',
    },
  ],
});
assert.deepEqual(calls.at(-1).args.slice(-2), ['dockmaster-provider', 'audit']);
assert.equal(calls.at(-1).options.timeout, 8_000);

const actionStates = {
  start: ['stopped', 'running', 20_000],
  stop: ['running', 'stopped', 20_000],
  restart: ['running', 'running', 30_000],
  pull: ['running', 'running', 120_000],
};

for (const [action, [previousState, state, timeout]] of Object.entries(actionStates)) {
  enqueueJson({
    ...service,
    state,
    previous_state: previousState,
    rollback: `docker compose ${previousState}`,
    secret: 'drop-me',
  });
  const result = await provider.request({ action, project: 'provider-demo', service: 'web' });
  assert.deepEqual(result, {
    ok: true,
    action,
    project: 'provider-demo',
    service: { ...normalizedService, state },
    previousState,
  });
  assert.equal(JSON.stringify(result).includes('rollback'), false);
  assert.deepEqual(calls.at(-1).args.slice(-5), [
    'dockmaster-provider', 'action', 'provider-demo', 'web', action,
  ]);
  assert.equal(calls.at(-1).options.timeout, timeout);
}

// Every invalid request is rejected before execFile can be reached.
const callsBeforeRejections = calls.length;
for (const request of [
  { action: 'shell', project: 'provider-demo', service: 'web' },
  { action: 'start', project: 'provider-demo;id', service: 'web' },
  { action: 'start', project: 'provider-demo', service: 'web$(id)' },
  { action: 'start', project: 'provider-demo', service: 'unknown' },
  { action: 'start', project: 'unknown', service: 'web' },
  { action: 'pull', project: 'provider-demo', service: 'worker' },
  { action: 'inventory', project: 'provider-demo' },
  { action: 'audit', limit: 100 },
  { action: 'stop', project: 'provider-demo', service: 'web', extra: 'smuggled' },
]) {
  await assert.rejects(
    provider.request(request),
    (error) => error instanceof RemoteProviderError && ['INVALID_REQUEST', 'NOT_ALLOWLISTED'].includes(error.code),
  );
}
assert.equal(calls.length, callsBeforeRejections);

// Provider failures never include stderr or remote response details.
enqueueFailure('SECRET_TOKEN=never-return-this');
await assert.rejects(
  provider.request({ action: 'inventory' }),
  (error) => (
    error instanceof RemoteProviderError
    && error.code === 'REMOTE_UNAVAILABLE'
    && !error.message.includes('SECRET_TOKEN')
    && !JSON.stringify(error).includes('SECRET_TOKEN')
  ),
);

queued.push({ stdout: '{not json', stderr: 'private detail' });
await assert.rejects(
  provider.request({ action: 'inventory' }),
  (error) => error instanceof RemoteProviderError && error.code === 'INVALID_RESPONSE' && !error.message.includes('private'),
);

enqueueJson({ ...inventoryWireResponse, schema: 'unknown/v2' });
await assert.rejects(
  provider.request({ action: 'inventory' }),
  (error) => error instanceof RemoteProviderError && error.code === 'INVALID_RESPONSE',
);

enqueueJson({ ...service, name: 'worker', previous_state: 'running', rollback: 'secret' });
await assert.rejects(
  provider.request({ action: 'stop', project: 'provider-demo', service: 'web' }),
  (error) => error instanceof RemoteProviderError && error.code === 'INVALID_RESPONSE',
);

queued.push({ stdout: 'x'.repeat((1024 * 1024) + 1), stderr: '' });
await assert.rejects(
  provider.request({ action: 'inventory' }),
  (error) => error instanceof RemoteProviderError && error.code === 'INVALID_RESPONSE',
);

const serverSource = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
assert.match(serverSource, /\/api\/providers\/dk-fsn1\/services/);
assert.match(serverSource, /remoteProvider\.request\(\{ action: 'inventory' \}\)/);
assert.match(serverSource, /remoteProvider\.request\(\{ action, project, service \}\)/);
assert.match(appSource, /\{ id: 'remote', label: 'Remote services' \}/);
assert.match(appSource, /function RemoteServices\(\)/);
assert.match(appSource, /item\.actions\.includes\('restart'\)/);
assert.match(appSource, /disabled=\{!item\.actions\.includes\(action\)\}/);

console.log('remote provider deployed-contract adapter passed');
