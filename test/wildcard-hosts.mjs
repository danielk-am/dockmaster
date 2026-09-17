import assert from 'node:assert/strict';
import { hostsFromRule, routedHosts, hostsFileNames, planHostsSync } from '../server/wildcard-hosts-lib.mjs';
import { dockerEnv, listContainers } from '../server/docker-lib.mjs';

// Coolify writes one https and one http router per domain, both Host-routed.
assert.deepEqual(hostsFromRule('Host(`browserless.m4.mac`) && PathPrefix(`/`)'), ['browserless.m4.mac']);
// Traefik v2's list form, and case folding.
assert.deepEqual(hostsFromRule('Host(`A.m4.mac`, `b.m4.mac`) || Host(`c.m4.mac`)'), ['a.m4.mac', 'b.m4.mac', 'c.m4.mac']);
// Other matchers are not hostnames.
assert.deepEqual(hostsFromRule('HostRegexp(`{sub:[a-z]+}.m4.mac`) && HostSNI(`x.m4.mac`)'), []);
assert.deepEqual(hostsFromRule(undefined), []);

const wildcards = ['*.m4.mac'];
const containers = [
  { Config: { Labels: {
    'traefik.http.routers.https-0-x-browserless.rule': 'Host(`browserless.m4.mac`) && PathPrefix(`/`)',
    'traefik.http.routers.http-0-x-browserless.rule': 'Host(`browserless.m4.mac`) && PathPrefix(`/`)',
    // A plain registered name has its own hosts line; not the sync's business.
    'traefik.http.routers.https-1-x-browserless.rule': 'Host(`browserless.mac`) && PathPrefix(`/`)',
    'traefik.http.services.x.loadbalancer.server.port': '3000',
  } } },
  { Config: { Labels: {
    'traefik.http.routers.https-0-y-librechat.rule': 'Host(`librechat.m4.mac`)',
    // Two labels under the base: *.m4.mac does not cover it, like Caddy.
    'traefik.http.routers.deep.rule': 'Host(`a.b.m4.mac`)',
    // Look-alike suffix.
    'traefik.http.routers.evil.rule': 'Host(`x.notm4.mac`)',
  } } },
  { Config: { Labels: null } },
  {},
];
assert.deepEqual(routedHosts(containers, wildcards), ['browserless.m4.mac', 'librechat.m4.mac']);
assert.deepEqual(routedHosts(containers, []), []);

// Only names mapped to the ingress alias count; comments, other IPs and IPv6
// lines do not.
const hostsText = [
  '##',
  '127.0.0.1\tlocalhost',
  '127.0.49.49\tplane.m4.mac',
  '127.0.49.49  n8n.m4.mac   extra.m4.mac # trailing',
  'fd49::4949 v6only.m4.mac',
  '# 127.0.49.49 commented.m4.mac',
  '10.0.0.1 other.m4.mac',
].join('\n');
assert.deepEqual([...hostsFileNames(hostsText)].sort(), ['extra.m4.mac', 'n8n.m4.mac', 'plane.m4.mac']);

// Adds what is missing; adopts what is already there; removes only names it
// managed that no router serves any more; never touches hand-made lines.
const plan = planHostsSync({
  wanted: ['librechat.m4.mac', 'plane.m4.mac'],
  present: new Set(['plane.m4.mac', 'gone.m4.mac', 'manual.m4.mac']),
  managed: ['gone.m4.mac', 'already-removed.m4.mac'],
});
assert.deepEqual(plan.add, ['librechat.m4.mac']);
assert.deepEqual(plan.remove, ['gone.m4.mac']);
assert.deepEqual(plan.managed, ['librechat.m4.mac', 'plane.m4.mac']);
assert.deepEqual(planHostsSync({ wanted: [], present: new Set(), managed: [] }), { add: [], remove: [], managed: [] });

// launchd starts the server without the shell's DOCKER_CONTEXT, and Colima
// does not own /var/run/docker.sock, so the CLI would find no engine.
const sock = `${process.env.HOME}/.colima/default/docker.sock`;
assert.equal(dockerEnv({ PATH: '/bin' }, true).DOCKER_HOST, `unix://${sock}`);
assert.equal(dockerEnv({ PATH: '/bin' }, false).DOCKER_HOST, undefined);
assert.equal(dockerEnv({ DOCKER_HOST: 'unix:///x.sock' }, true).DOCKER_HOST, 'unix:///x.sock');
assert.equal(dockerEnv({ DOCKER_CONTEXT: 'colima' }, true).DOCKER_HOST, undefined);

// Stopped containers still count, so a restart does not drop their names;
// an unreachable engine returns null so the caller changes nothing.
const calls = [];
const fakeDocker = (out) => async (args) => { calls.push(args); return out(args); };
assert.equal(await listContainers({ docker: fakeDocker(() => ({ ok: false, stdout: '', stderr: 'Cannot connect' })) }), null);
assert.deepEqual(calls.at(-1), ['ps', '-aq']);
assert.deepEqual(await listContainers({ docker: fakeDocker(() => ({ ok: true, stdout: '\n', stderr: '' })) }), []);
const listed = await listContainers({ docker: fakeDocker((args) => (
  args[0] === 'ps' ? { ok: true, stdout: 'aaa\nbbb\n', stderr: '' } : { ok: true, stdout: JSON.stringify([{ Id: 'aaa' }, { Id: 'bbb' }]), stderr: '' }
)) });
assert.deepEqual(listed.map((c) => c.Id), ['aaa', 'bbb']);
assert.deepEqual(calls.at(-1), ['inspect', 'aaa', 'bbb']);
assert.equal(await listContainers({ docker: fakeDocker((args) => (
  args[0] === 'ps' ? { ok: true, stdout: 'aaa\n', stderr: '' } : { ok: true, stdout: 'not json', stderr: '' }
)) }), null);

console.log('wildcard-hosts: ok');
