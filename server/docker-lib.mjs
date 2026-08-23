import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const DOCKER_CANDIDATES = [
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
];

const dockerCommand = () => DOCKER_CANDIDATES.find(existsSync) || 'docker';

const runDocker = (args, timeout = 6000) => new Promise((resolve) => {
  execFile(dockerCommand(), args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({
      ok: !error,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
    });
  });
});

const connectAddress = (hostIp) => (
  !hostIp || hostIp === '0.0.0.0' || hostIp === '::' ? '127.0.0.1' : hostIp
);

const requestProtocol = (protocol, host, port, timeout) => new Promise((resolve) => {
  const client = protocol === 'https' ? https : http;
  const request = client.request({
    host,
    port,
    path: '/',
    method: 'HEAD',
    headers: { 'User-Agent': 'Dockmaster Docker discovery' },
    rejectUnauthorized: false,
  }, (response) => {
    const statusCode = response.statusCode || null;
    response.resume();
    resolve({ protocol, statusCode });
  });
  request.setTimeout(timeout, () => request.destroy(new Error('probe timeout')));
  request.on('error', () => resolve(null));
  request.end();
});

export async function probeWebBinding(binding, timeout = 900) {
  const host = connectAddress(binding.hostIp);
  return (
    await requestProtocol('http', host, binding.hostPort, timeout)
    || await requestProtocol('https', host, binding.hostPort, timeout)
  );
}

const preferredBinding = (bindings) => (
  bindings.find((binding) => binding.HostIp === '127.0.0.1')
  || bindings.find((binding) => binding.HostIp === '0.0.0.0')
  || bindings[0]
);

const suggestedName = (container, service) => (
  service || container.replace(/-\d+$/, '') || 'service'
)
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 63) || 'service';

// Convert Docker inspect output into one row per published host TCP port.
// Docker Desktop publishes the same port twice for wildcard IPv4 + IPv6, so
// the host-port key deliberately collapses those into one ingress candidate.
export function publishedDockerBindings(containers) {
  const rows = [];
  for (const container of containers) {
    const labels = container.Config?.Labels || {};
    const name = String(container.Name || '').replace(/^\//, '');
    const project = labels['com.docker.compose.project'] || null;
    const service = labels['com.docker.compose.service'] || name;
    const ports = container.NetworkSettings?.Ports || {};
    const seen = new Set();

    for (const [containerSocket, hostBindings] of Object.entries(ports)) {
      const match = containerSocket.match(/^(\d+)\/(tcp|udp)$/);
      if (!match || match[2] !== 'tcp' || !Array.isArray(hostBindings) || !hostBindings.length) continue;
      const containerPort = Number(match[1]);
      const validBindings = hostBindings.filter((binding) => Number(binding.HostPort) > 0);

      for (const hostPort of [...new Set(validBindings.map((binding) => Number(binding.HostPort)))]) {
        const key = `${container.Id}:${hostPort}:${containerPort}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const matchingBindings = validBindings.filter((binding) => Number(binding.HostPort) === hostPort);
        const binding = preferredBinding(matchingBindings);
        const publicBind = matchingBindings.some(({ HostIp }) => HostIp === '0.0.0.0' || HostIp === '::');
        rows.push({
          id: key,
          containerId: String(container.Id || '').slice(0, 12),
          container: name,
          image: container.Config?.Image || container.Image || '',
          project,
          service,
          suggestedName: suggestedName(name, service),
          hostIp: binding?.HostIp || '',
          hostPort,
          containerPort,
          publicBind,
          state: container.State?.Status || 'unknown',
          health: container.State?.Health?.Status || null,
        });
      }
    }
  }
  return rows.sort((a, b) => a.hostPort - b.hostPort || a.container.localeCompare(b.container));
}

const conciseDockerError = (stderr) => {
  const firstLine = stderr.trim().split('\n').find(Boolean) || '';
  if (/Cannot connect to the Docker daemon|Is the docker daemon running/i.test(firstLine)) {
    return 'Docker is installed, but its engine is unavailable.';
  }
  if (/ENOENT|not found/i.test(firstLine)) return 'Docker CLI is not installed.';
  return firstLine || 'Docker discovery is unavailable.';
};

export async function discoverDockerWebServices({
  docker = runDocker,
  probe = probeWebBinding,
} = {}) {
  const listed = await docker(['ps', '-q'], 3500);
  if (!listed.ok) {
    return { available: false, error: conciseDockerError(listed.stderr), services: [] };
  }

  const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
  if (!ids.length) return { available: true, containers: 0, publishedPorts: 0, services: [] };

  const inspected = await docker(['inspect', ...ids], 6500);
  if (!inspected.ok) {
    return { available: false, error: conciseDockerError(inspected.stderr), services: [] };
  }

  let containers;
  try {
    containers = JSON.parse(inspected.stdout);
  } catch {
    return { available: false, error: 'Docker returned unreadable container metadata.', services: [] };
  }

  const bindings = publishedDockerBindings(Array.isArray(containers) ? containers : []);
  const probed = await Promise.all(bindings.map(async (binding) => {
    const web = await probe(binding);
    return web ? { ...binding, ...web } : null;
  }));
  const services = probed.filter(Boolean);

  return {
    available: true,
    containers: containers.length,
    publishedPorts: bindings.length,
    ignoredNonWebPorts: bindings.length - services.length,
    services,
  };
}
