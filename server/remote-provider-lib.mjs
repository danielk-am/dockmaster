import { execFile } from 'node:child_process';

const SSH_PATH = '/usr/bin/ssh';
const PROVIDER_USER = 'dockmaster-provider';
const REMOTE_PROGRAM = 'dockmaster-provider';
const CONNECT_TIMEOUT_SECONDS = 5;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const INVENTORY_SCHEMA = 'dockmaster-provider-inventory/v1';
const READ_ACTIONS = new Set(['inventory', 'audit']);
const LIFECYCLE_ACTIONS = new Set(['start', 'stop', 'restart', 'pull']);
const ALL_ACTIONS = new Set([...READ_ACTIONS, ...LIFECYCLE_ACTIONS]);
const AUDIT_ACTIONS = new Set([...ALL_ACTIONS, 'routes-apply', 'routes-remove']);
const ACTION_ORDER = ['start', 'stop', 'restart', 'pull'];
const ACTION_TIMEOUT_MS = Object.freeze({
  inventory: 8_000,
  audit: 8_000,
  start: 20_000,
  stop: 20_000,
  restart: 30_000,
  pull: 120_000,
});
const IDENTIFIER_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const STATES = new Set(['created', 'exited', 'missing', 'mixed', 'paused', 'restarting', 'running', 'stopped', 'unknown']);
const HEALTH_STATES = new Set(['healthy', 'mixed', 'none', 'starting', 'unhealthy', 'unknown']);
const AUDIT_RESULTS = new Set(['ok', 'failed', 'refused']);
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;
const CONFIG_KEYS = ['sshPath', 'host', 'user', 'identityFile'];
const ENV_KEYS = [
  'DOCKMASTER_REMOTE_PROVIDER_HOST',
  'DOCKMASTER_REMOTE_PROVIDER_IDENTITY_FILE',
  'DOCKMASTER_REMOTE_PROVIDER_ALLOWLIST',
];

export class RemoteProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RemoteProviderError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new RemoteProviderError(code, message);
};

const invalidConfig = () => fail('INVALID_CONFIG', 'Remote provider configuration is invalid.');
const invalidRequest = () => fail('INVALID_REQUEST', 'Remote provider request is invalid.');
const invalidResponse = () => fail('INVALID_RESPONSE', 'Remote provider returned an invalid response.');

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (value, expected) => {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

const validateConfig = (config) => {
  if (!hasExactKeys(config, CONFIG_KEYS)) invalidConfig();
  if (config.sshPath !== SSH_PATH || config.user !== PROVIDER_USER) invalidConfig();
  if (
    typeof config.host !== 'string'
    || !HOST_RE.test(config.host)
    || config.host.includes('..')
  ) invalidConfig();
  if (
    typeof config.identityFile !== 'string'
    || !config.identityFile.startsWith('/')
    || config.identityFile.length > 1024
    || /[\u0000-\u001f\u007f]/.test(config.identityFile)
    || config.identityFile.split('/').includes('..')
    || /^(?:\/private)?\/(?:var\/)?tmp(?:\/|$)/.test(config.identityFile)
  ) invalidConfig();
  return Object.freeze({ ...config });
};

export const remoteProviderOptionsFromEnvironment = (environment = process.env) => {
  const values = ENV_KEYS.map((key) => environment[key]);
  if (values.every((value) => value === undefined || value === '')) return null;
  if (values.some((value) => typeof value !== 'string' || value === '')) invalidConfig();
  if (environment.DOCKMASTER_REMOTE_PROVIDER_ALLOWLIST.length > 64 * 1024) invalidConfig();
  let allowlist;
  try {
    allowlist = JSON.parse(environment.DOCKMASTER_REMOTE_PROVIDER_ALLOWLIST);
  } catch {
    invalidConfig();
  }
  return Object.freeze({
    config: validateConfig({
      sshPath: SSH_PATH,
      host: environment.DOCKMASTER_REMOTE_PROVIDER_HOST,
      user: PROVIDER_USER,
      identityFile: environment.DOCKMASTER_REMOTE_PROVIDER_IDENTITY_FILE,
    }),
    allowlist,
  });
};

const normalizeAllowlist = (allowlist) => {
  if (!isPlainObject(allowlist) || Object.keys(allowlist).length === 0) invalidConfig();
  const projects = new Map();

  for (const [project, services] of Object.entries(allowlist)) {
    if (!IDENTIFIER_RE.test(project) || !isPlainObject(services) || Object.keys(services).length === 0) {
      invalidConfig();
    }
    const normalizedServices = new Map();
    for (const [service, actions] of Object.entries(services)) {
      if (!IDENTIFIER_RE.test(service) || !Array.isArray(actions)) invalidConfig();
      const normalizedActions = new Set();
      for (const action of actions) {
        if (!LIFECYCLE_ACTIONS.has(action) || normalizedActions.has(action)) invalidConfig();
        normalizedActions.add(action);
      }
      normalizedServices.set(service, normalizedActions);
    }
    projects.set(project, normalizedServices);
  }
  return projects;
};

const requireRequestIdentifier = (value) => {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) invalidRequest();
  return value;
};

const requireResponseIdentifier = (value) => {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) invalidResponse();
  return value;
};

const requireOpaqueId = (value) => {
  if (typeof value !== 'string' || !OPAQUE_ID_RE.test(value)) invalidResponse();
  return value;
};

const requireText = (value, maxLength = 300) => {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)
  ) invalidResponse();
  return value;
};

const optionalText = (value, maxLength = 300) => (
  value === null ? null : requireText(value, maxLength)
);

const requireTimestamp = (value) => {
  requireText(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) invalidResponse();
  return value;
};

const requireEnum = (value, allowed) => {
  if (typeof value !== 'string' || !allowed.has(value)) invalidResponse();
  return value;
};

const optionalEnum = (value, allowed) => (
  value === null ? null : requireEnum(value, allowed)
);

const requirePortNumber = (value) => {
  if (!Number.isInteger(value) || value < 1 || value > 65535) invalidResponse();
  return value;
};

const optionalPortNumber = (value) => (
  value === null || value === '' ? null : requirePortNumber(typeof value === 'string' ? Number(value) : value)
);

const requireContainerPort = (value) => {
  if (typeof value === 'number') return { containerPort: requirePortNumber(value), protocol: 'tcp' };
  if (typeof value !== 'string') invalidResponse();
  const match = value.match(/^(\d{1,5})\/(tcp|udp)$/);
  if (!match) invalidResponse();
  return { containerPort: requirePortNumber(Number(match[1])), protocol: match[2] };
};

const actionSetFor = (allowlist, project, service) => allowlist.get(project)?.get(service) || null;

const validateRequest = (request, allowlist) => {
  if (!isPlainObject(request) || typeof request.action !== 'string' || !ALL_ACTIONS.has(request.action)) {
    invalidRequest();
  }
  if (READ_ACTIONS.has(request.action)) {
    if (!hasExactKeys(request, ['action'])) invalidRequest();
    return Object.freeze({ action: request.action });
  }
  if (!hasExactKeys(request, ['action', 'project', 'service'])) invalidRequest();
  const project = requireRequestIdentifier(request.project);
  const service = requireRequestIdentifier(request.service);
  const allowedActions = actionSetFor(allowlist, project, service);
  if (!allowedActions?.has(request.action)) {
    fail('NOT_ALLOWLISTED', 'Remote provider target or action is not allowlisted.');
  }
  return Object.freeze({ action: request.action, project, service });
};

const sshArgs = (request, config) => {
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'PermitLocalCommand=no',
    '-o', `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
    '-i', config.identityFile,
    '-l', config.user,
    '--', config.host,
    REMOTE_PROGRAM,
  ];
  if (READ_ACTIONS.has(request.action)) return [...args, request.action];
  return [...args, 'action', request.project, request.service, request.action];
};

const sanitizePort = (wire) => {
  if (!isPlainObject(wire)) invalidResponse();
  const container = requireContainerPort(wire.container);
  return {
    ...container,
    hostIp: wire.host_ip === '' ? null : optionalText(wire.host_ip, 64),
    hostPort: optionalPortNumber(wire.host_port),
  };
};

const sanitizePorts = (ports) => {
  if (!Array.isArray(ports) || ports.length > 128) invalidResponse();
  return ports.map(sanitizePort);
};

const sanitizeContainer = (wire) => {
  if (!isPlainObject(wire)) invalidResponse();
  return {
    id: requireText(wire.id, 160),
    container: requireText(wire.container, 160),
    image: optionalText(wire.image, 300),
    state: requireEnum(wire.state, STATES),
    health: optionalEnum(wire.health, HEALTH_STATES),
    ports: sanitizePorts(wire.ports),
  };
};

const sanitizeAdvertisedActions = (actions, allowedActions) => {
  if (!Array.isArray(actions) || actions.length > 16) invalidResponse();
  for (const action of actions) {
    if (typeof action !== 'string' || action.length > 32 || /[\u0000-\u001f\u007f]/.test(action)) {
      invalidResponse();
    }
  }
  const advertised = new Set(actions);
  return ACTION_ORDER.filter((action) => advertised.has(action) && allowedActions.has(action));
};

const sanitizeHealthPath = (value) => {
  if (value === null) return null;
  const path = requireText(value, 256);
  if (!path.startsWith('/')) invalidResponse();
  return path;
};

const sanitizeRoute = (value) => {
  if (value === null) return null;
  if (!isPlainObject(value)) invalidResponse();
  const hostname = requireText(value.hostname, 253);
  const entrypoint = requireEnum(value.entrypoint, new Set(['http', 'https']));
  const service = requireResponseIdentifier(value.service);
  return { hostname, entrypoint, service };
};

const sanitizeService = (wire, allowedActions, expectedName = null) => {
  if (!isPlainObject(wire)) invalidResponse();
  const name = requireResponseIdentifier(wire.name);
  if (expectedName !== null && name !== expectedName) invalidResponse();
  if (!Array.isArray(wire.containers) || wire.containers.length > 100) invalidResponse();
  return {
    name,
    state: requireEnum(wire.state, STATES),
    health: optionalEnum(wire.health, HEALTH_STATES),
    image: optionalText(wire.image, 300),
    ports: sanitizePorts(wire.ports),
    containers: wire.containers.map(sanitizeContainer),
    actions: sanitizeAdvertisedActions(wire.actions, allowedActions),
    internalPort: optionalPortNumber(wire.internal_port),
    healthPath: sanitizeHealthPath(wire.health_path),
    owner: optionalText(wire.owner, 160),
  };
};

const sanitizeProject = (wire, allowlist) => {
  if (!isPlainObject(wire)) invalidResponse();
  const id = requireResponseIdentifier(wire.id);
  const project = requireResponseIdentifier(wire.project);
  const allowedServices = allowlist.get(id);
  if (!allowedServices) return null;
  if (!Array.isArray(wire.services) || wire.services.length > 500) invalidResponse();

  const seen = new Set();
  const services = [];
  for (const serviceWire of wire.services) {
    if (!isPlainObject(serviceWire)) invalidResponse();
    const name = requireResponseIdentifier(serviceWire.name);
    if (seen.has(name)) invalidResponse();
    seen.add(name);
    const allowedActions = allowedServices.get(name);
    if (allowedActions) services.push(sanitizeService(serviceWire, allowedActions, name));
  }

  return {
    id,
    project,
    owner: optionalText(wire.owner, 160),
    route: sanitizeRoute(wire.route),
    services,
  };
};

const sanitizeInventory = (wire, allowlist) => {
  if (!isPlainObject(wire) || wire.schema !== INVENTORY_SCHEMA || !Array.isArray(wire.projects)) {
    invalidResponse();
  }
  if (wire.projects.length > 100) invalidResponse();
  const seen = new Set();
  const projects = [];
  for (const projectWire of wire.projects) {
    if (!isPlainObject(projectWire)) invalidResponse();
    const projectId = requireResponseIdentifier(projectWire.id);
    if (seen.has(projectId)) invalidResponse();
    seen.add(projectId);
    const project = sanitizeProject(projectWire, allowlist);
    if (project) projects.push(project);
  }
  return {
    ok: true,
    action: 'inventory',
    schema: INVENTORY_SCHEMA,
    generatedAt: requireTimestamp(wire.generated_at),
    projects,
  };
};

const sanitizeAuditRecord = (wire) => {
  if (!isPlainObject(wire)) invalidResponse();
  return {
    requestId: requireOpaqueId(wire.request_id),
    timestamp: requireTimestamp(wire.timestamp),
    actor: requireText(wire.actor, 160),
    action: requireEnum(wire.action, AUDIT_ACTIONS),
    target: requireText(wire.target, 160),
    result: requireEnum(wire.result, AUDIT_RESULTS),
  };
};

const sanitizeAudit = (wire) => {
  if (!isPlainObject(wire) || !Array.isArray(wire.records) || wire.records.length > 500) {
    invalidResponse();
  }
  return {
    ok: true,
    action: 'audit',
    records: wire.records.map(sanitizeAuditRecord),
  };
};

const sanitizeLifecycle = (wire, request, allowlist) => {
  if (!isPlainObject(wire)) invalidResponse();
  const allowedActions = actionSetFor(allowlist, request.project, request.service);
  return {
    ok: true,
    action: request.action,
    project: request.project,
    service: sanitizeService(wire, allowedActions, request.service),
    previousState: requireEnum(wire.previous_state, STATES),
  };
};

const sanitizeResponse = (wire, request, allowlist) => {
  if (request.action === 'inventory') return sanitizeInventory(wire, allowlist);
  if (request.action === 'audit') return sanitizeAudit(wire);
  return sanitizeLifecycle(wire, request, allowlist);
};

const parseResponse = (stdout, request, allowlist) => {
  const text = typeof stdout === 'string' ? stdout : String(stdout || '');
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) invalidResponse();
  let wire;
  try {
    wire = JSON.parse(text);
  } catch {
    invalidResponse();
  }
  return sanitizeResponse(wire, request, allowlist);
};

export function createRemoteProvider(options) {
  if (!isPlainObject(options)) invalidConfig();
  const allowedOptionKeys = new Set(['allowlist', 'execFileImpl', 'config']);
  if (Object.keys(options).some((key) => !allowedOptionKeys.has(key))) invalidConfig();
  const {
    allowlist,
    execFileImpl = execFile,
    config,
  } = options;
  const normalizedConfig = validateConfig(config);
  if (typeof execFileImpl !== 'function') invalidConfig();
  const normalizedAllowlist = normalizeAllowlist(allowlist);

  return Object.freeze({
    request(input) {
      let request;
      try {
        request = validateRequest(input, normalizedAllowlist);
      } catch (error) {
        return Promise.reject(error);
      }

      return new Promise((resolve, reject) => {
        const callback = (error, stdout) => {
          if (error) {
            reject(new RemoteProviderError('REMOTE_UNAVAILABLE', 'Remote provider is unavailable.'));
            return;
          }
          try {
            resolve(parseResponse(stdout, request, normalizedAllowlist));
          } catch (responseError) {
            reject(responseError instanceof RemoteProviderError
              ? responseError
              : new RemoteProviderError('INVALID_RESPONSE', 'Remote provider returned an invalid response.'));
          }
        };

        try {
          execFileImpl(
            normalizedConfig.sshPath,
            sshArgs(request, normalizedConfig),
            {
              encoding: 'utf8',
              killSignal: 'SIGKILL',
              maxBuffer: MAX_OUTPUT_BYTES,
              shell: false,
              timeout: ACTION_TIMEOUT_MS[request.action],
              windowsHide: true,
            },
            callback,
          );
        } catch {
          reject(new RemoteProviderError('REMOTE_UNAVAILABLE', 'Remote provider is unavailable.'));
        }
      });
    },
  });
}
