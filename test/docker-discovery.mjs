import assert from 'node:assert/strict';
import { discoverDockerWebServices, publishedDockerBindings } from '../server/docker-lib.mjs';

const containers = [
  {
    Id: 'a'.repeat(64),
    Name: '/n8n-a8c-n8n-1',
    Config: {
      Image: 'n8nio/n8n:latest',
      Labels: {
        'com.docker.compose.project': 'n8n-a8c',
        'com.docker.compose.service': 'n8n',
      },
    },
    State: { Status: 'running' },
    NetworkSettings: {
      Ports: {
        '5678/tcp': [
          { HostIp: '0.0.0.0', HostPort: '5678' },
          { HostIp: '::', HostPort: '5678' },
        ],
      },
    },
  },
  {
    Id: 'b'.repeat(64),
    Name: '/librechat-a8c',
    Config: {
      Image: 'librechat-a8c:local',
      Labels: {
        'com.docker.compose.project': 'librechat-a8c',
        'com.docker.compose.service': 'librechat',
      },
    },
    State: { Status: 'running', Health: { Status: 'healthy' } },
    NetworkSettings: {
      Ports: {
        '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: '3080' }],
        '3080/udp': [{ HostIp: '127.0.0.1', HostPort: '3080' }],
      },
    },
  },
  {
    Id: 'c'.repeat(64),
    Name: '/internal-only',
    Config: { Image: 'internal:latest', Labels: null },
    State: { Status: 'running' },
    NetworkSettings: { Ports: { '9000/tcp': null } },
  },
];

const bindings = publishedDockerBindings(containers);
assert.equal(bindings.length, 2, 'IPv4/IPv6 and UDP bindings must not create duplicate web candidates');
assert.deepEqual(bindings.map(({ hostPort }) => hostPort), [3080, 5678]);
assert.equal(bindings[0].health, 'healthy');
assert.equal(bindings[0].publicBind, false);
assert.equal(bindings[1].service, 'n8n');
assert.equal(bindings[1].suggestedName, 'n8n');
assert.equal(bindings[1].publicBind, true);

const docker = async (args) => {
  if (args[0] === 'ps') return { ok: true, stdout: 'a\nb\nc\n', stderr: '' };
  return { ok: true, stdout: JSON.stringify(containers), stderr: '' };
};
const discovered = await discoverDockerWebServices({
  docker,
  probe: async ({ hostPort }) => (
    hostPort === 5678 ? { protocol: 'http', statusCode: 200 } : null
  ),
});
assert.equal(discovered.available, true);
assert.equal(discovered.containers, 3);
assert.equal(discovered.publishedPorts, 2);
assert.equal(discovered.ignoredNonWebPorts, 1);
assert.deepEqual(discovered.services.map(({ service }) => service), ['n8n']);

const offline = await discoverDockerWebServices({
  docker: async () => ({ ok: false, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///tmp/docker.sock.\n' }),
});
assert.equal(offline.available, false);
assert.equal(offline.error, 'Docker is installed, but its engine is unavailable.');

console.log('docker discovery fixtures passed');
