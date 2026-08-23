import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(tmpdir(), 'dockmaster-auto-apply-'));

const write = (file, content) => writeFileSync(file, content, 'utf8');
const read = (file) => readFileSync(file, 'utf8');
const run = (command, args, env) => spawnSync(command, args, {
  encoding: 'utf8',
  env: { ...process.env, ...env, DOCKMASTER_AUTO_TEST_MODE: '1' },
});

try {
  const dnsRoot = path.join(root, 'dns');
  const dnsState = path.join(dnsRoot, 'state');
  mkdirSync(dnsState, { recursive: true });
  const dnsmasq = path.join(dnsRoot, 'dnsmasq.conf');
  const hosts = path.join(dnsRoot, 'hosts');
  write(dnsmasq, 'address=/existing.test/127.0.49.49\n');
  write(hosts, '127.0.0.1 localhost\n');
  write(path.join(dnsState, 'dns-pending.conf'), [
    'address=/new.test/127.0.49.49',
    'address=/new.test/fd49::4949',
    'address=/bad.test/8.8.8.8',
    '',
  ].join('\n'));
  write(path.join(dnsState, 'hosts-pending.conf'), [
    '127.0.49.49 new.test',
    'fd49::4949 new.test',
    '8.8.8.8 bad.test',
    '',
  ].join('\n'));
  const staleDnsClaim = path.join(dnsState, 'dns-pending.conf.applying.42');
  write(staleDnsClaim, 'address=/recovered.test/127.0.49.49\n');

  const dnsEnv = {
    DOCKMASTER_AUTO_STATE_DIR: dnsState,
    DOCKMASTER_AUTO_DNSMASQ_CONF: dnsmasq,
    DOCKMASTER_AUTO_HOSTS_FILE: hosts,
  };
  const dnsResult = run('/bin/bash', [path.join(repo, 'deploy/apply-dns.sh')], dnsEnv);
  assert.equal(dnsResult.status, 0, dnsResult.stderr);
  assert.match(read(dnsmasq), /address=\/new\.test\/127\.0\.49\.49/);
  assert.match(read(dnsmasq), /address=\/new\.test\/fd49::4949/);
  assert.match(read(dnsmasq), /address=\/recovered\.test\/127\.0\.49\.49/);
  assert.doesNotMatch(read(dnsmasq), /8\.8\.8\.8/);
  assert.match(read(hosts), /127\.0\.49\.49 new\.test/);
  assert.match(read(hosts), /fd49::4949 new\.test/);
  assert.doesNotMatch(read(hosts), /8\.8\.8\.8/);
  assert.equal(read(path.join(dnsState, 'dns-pending.conf')), '');
  assert.equal(read(path.join(dnsState, 'hosts-pending.conf')), '');
  assert.ok(statSync(`${dnsmasq}.dockmaster.bak`).isFile());
  assert.ok(statSync(`${hosts}.dockmaster.bak`).isFile());
  assert.equal(readdirSync(dnsState).includes(path.basename(staleDnsClaim)), false);

  const dnsBefore = read(dnsmasq);
  const hostsBefore = read(hosts);
  const dnsNoop = run('/bin/bash', [path.join(repo, 'deploy/apply-dns.sh')], dnsEnv);
  assert.equal(dnsNoop.status, 0, `${dnsNoop.stdout}\n${dnsNoop.stderr}`);
  assert.equal(read(dnsmasq), dnsBefore);
  assert.equal(read(hosts), hostsBefore);

  const failedDnsRoot = path.join(root, 'failed-dns');
  const failedDnsState = path.join(failedDnsRoot, 'state');
  mkdirSync(failedDnsState, { recursive: true });
  const failedDnsmasq = path.join(failedDnsRoot, 'dnsmasq.conf');
  const failedDnsHosts = path.join(failedDnsRoot, 'hosts');
  write(failedDnsmasq, '# dnsmasq\n');
  write(failedDnsHosts, '127.0.0.1 localhost\n');
  write(path.join(failedDnsState, 'dns-pending.conf'), 'address=/retry.test/127.0.49.49\n');
  write(path.join(failedDnsState, 'hosts-pending.conf'), '');
  // Force the backup copy to fail after the queue has been claimed.
  mkdirSync(path.join(`${failedDnsmasq}.dockmaster.bak`, path.basename(failedDnsmasq)), { recursive: true });
  const failedDnsResult = run('/bin/bash', [path.join(repo, 'deploy/apply-dns.sh')], {
    DOCKMASTER_AUTO_STATE_DIR: failedDnsState,
    DOCKMASTER_AUTO_DNSMASQ_CONF: failedDnsmasq,
    DOCKMASTER_AUTO_HOSTS_FILE: failedDnsHosts,
  });
  assert.notEqual(failedDnsResult.status, 0, `${failedDnsResult.stdout}\n${failedDnsResult.stderr}`);
  assert.equal(read(path.join(failedDnsState, 'dns-pending.conf')), '');
  assert.ok(readdirSync(failedDnsState).some((file) => file.startsWith('dns-pending.conf.failed-')));

  const editsRoot = path.join(root, 'edits');
  const editsState = path.join(editsRoot, 'state');
  const resolver = path.join(editsRoot, 'resolver');
  mkdirSync(editsState, { recursive: true });
  mkdirSync(resolver, { recursive: true });
  const editsFile = path.join(editsState, 'observed-edits.json');
  const editsHosts = path.join(editsRoot, 'hosts');
  const editsMasq = path.join(editsRoot, 'dnsmasq.conf');
  write(editsHosts, '127.0.0.1 localhost\n127.0.49.49 old.test keep.test\nfd49::4949 old.test\n');
  write(editsMasq, 'address=/old.test/127.0.49.49\naddress=/old.test/fd49::4949\n');
  write(editsFile, `${JSON.stringify([
    { kind: 'hosts-del', name: 'old.test' },
    { kind: 'hosts-set', name: 'new.test', ip: '127.0.49.49' },
    { kind: 'dnsmasq-del', key: 'old.test' },
    { kind: 'dnsmasq-set', key: 'new.test', ip: '127.0.49.49' },
    { kind: 'resolver-write', file: 'demo', content: 'nameserver 127.0.0.1\nport 53\n' },
    { kind: 'resolver-write', file: '../bad', content: 'nameserver 1.1.1.1\n' },
    { kind: 'hosts-set', name: 'bad.test', ip: '999.999.999.999' },
    { kind: 'proxy-bypass-set', service: 'Wi-Fi', domains: ['*.test', '*.a8c', '192.168.50.0/24'] },
    // Refused: an entry that is not a hostname, suffix, address, or CIDR.
    { kind: 'proxy-bypass-set', service: 'Wi-Fi', domains: ['*.test', 'rm -rf /'] },
    // Refused: a service name that is not a plausible network service.
    { kind: 'proxy-bypass-set', service: 'Wi-Fi; rm -rf /', domains: ['*.test'] },
    // Refused: domains must be a list.
    { kind: 'proxy-bypass-set', service: 'Wi-Fi', domains: '*.test' },
  ], null, 2)}\n`);

  const editsEnv = {
    DOCKMASTER_AUTO_STATE_DIR: editsState,
    DOCKMASTER_AUTO_EDITS_FILE: editsFile,
    DOCKMASTER_AUTO_HOSTS_FILE: editsHosts,
    DOCKMASTER_AUTO_DNSMASQ_CONF: editsMasq,
    DOCKMASTER_AUTO_RESOLVER_DIR: resolver,
  };
  const editsResult = run(process.execPath, [path.join(repo, 'deploy/apply-edits.mjs')], editsEnv);
  assert.equal(editsResult.status, 0, editsResult.stderr);
  assert.doesNotMatch(read(editsHosts), /old\.test/);
  assert.match(read(editsHosts), /127\.0\.49\.49\tkeep\.test/);
  assert.match(read(editsHosts), /127\.0\.49\.49\tnew\.test/);
  assert.doesNotMatch(read(editsHosts), /bad\.test/);
  assert.doesNotMatch(read(editsMasq), /old\.test/);
  assert.match(read(editsMasq), /address=\/new\.test\/127\.0\.49\.49/);
  assert.equal(read(path.join(resolver, 'demo')), 'nameserver 127.0.0.1\nport 53\n');
  assert.equal(read(editsFile), '[]\n');
  assert.ok(statSync(`${editsHosts}.dockmaster.bak`).isFile());
  assert.ok(statSync(`${editsMasq}.dockmaster.bak`).isFile());
  // The proxy bypass rides the same queue, so the root worker needs no new
  // watch path. Only the well-formed entry survives re-validation.
  assert.match(editsResult.stdout, /proxy: Wi-Fi bypass -> \*\.test, \*\.a8c, 192\.168\.50\.0\/24/);
  assert.doesNotMatch(editsResult.stdout, /rm -rf/);
  assert.equal((editsResult.stdout.match(/^proxy: /gm) || []).length, 1);
  assert.equal((editsResult.stderr.match(/Rejected invalid edit/g) || []).length, 5);

  const emptyMtime = statSync(editsFile).mtimeMs;
  const editsNoop = run(process.execPath, [path.join(repo, 'deploy/apply-edits.mjs')], editsEnv);
  assert.equal(editsNoop.status, 0, editsNoop.stderr);
  assert.equal(statSync(editsFile).mtimeMs, emptyMtime, 'empty queue must not be rewritten');

  const staleEditClaim = path.join(editsState, 'observed-edits.json.applying.42');
  write(staleEditClaim, '[{"kind":"hosts-set","name":"recovered.test","ip":"127.0.49.49"}]\n');
  const recoveredEdit = run(process.execPath, [path.join(repo, 'deploy/apply-edits.mjs')], editsEnv);
  assert.equal(recoveredEdit.status, 0, recoveredEdit.stderr);
  assert.match(read(editsHosts), /127\.0\.49\.49\trecovered\.test/);
  assert.equal(readdirSync(editsState).includes(path.basename(staleEditClaim)), false);

  const failedRoot = path.join(root, 'failed');
  const failedState = path.join(failedRoot, 'state');
  mkdirSync(failedState, { recursive: true });
  const failedQueue = path.join(failedState, 'observed-edits.json');
  write(failedQueue, '[{"kind":"hosts-del","name":"old.test"}]\n');
  const failedResult = run(process.execPath, [path.join(repo, 'deploy/apply-edits.mjs')], {
    DOCKMASTER_AUTO_STATE_DIR: failedState,
    DOCKMASTER_AUTO_EDITS_FILE: failedQueue,
    DOCKMASTER_AUTO_HOSTS_FILE: path.join(failedRoot, 'missing-hosts'),
    DOCKMASTER_AUTO_DNSMASQ_CONF: path.join(failedRoot, 'missing-dnsmasq'),
    DOCKMASTER_AUTO_RESOLVER_DIR: path.join(failedRoot, 'missing-resolver'),
  });
  assert.notEqual(failedResult.status, 0);
  assert.equal(read(failedQueue), '[]\n');
  assert.ok(readdirSync(failedState).some((file) => file.startsWith('observed-edits.json.failed-')));

  const workerRoot = path.join(root, 'worker');
  const workerState = path.join(workerRoot, 'state');
  const workerResolver = path.join(workerRoot, 'resolver');
  const workerActivity = path.join(workerRoot, 'activity.log');
  const workerHeartbeat = path.join(workerRoot, 'heartbeat');
  const workerHosts = path.join(workerRoot, 'hosts');
  const workerMasq = path.join(workerRoot, 'dnsmasq.conf');
  const workerEdits = path.join(workerState, 'observed-edits.json');
  mkdirSync(workerState, { recursive: true });
  mkdirSync(workerResolver, { recursive: true });
  write(workerHosts, '127.0.0.1 localhost\n');
  write(workerMasq, '# dnsmasq\n');
  write(path.join(workerState, 'dns-pending.conf'), 'address=/worker.test/127.0.49.49\n');
  write(path.join(workerState, 'hosts-pending.conf'), '127.0.49.49 worker.test\n');
  write(workerEdits, '[]\n');
  write(workerActivity, '');
  const workerEnv = {
    DOCKMASTER_AUTO_STATE_DIR: workerState,
    DOCKMASTER_AUTO_EDITS_FILE: workerEdits,
    DOCKMASTER_AUTO_HOSTS_FILE: workerHosts,
    DOCKMASTER_AUTO_DNSMASQ_CONF: workerMasq,
    DOCKMASTER_AUTO_RESOLVER_DIR: workerResolver,
    DOCKMASTER_AUTO_ACTIVITY_LOG: workerActivity,
    DOCKMASTER_AUTO_HEARTBEAT_FILE: workerHeartbeat,
    DOCKMASTER_AUTO_LOCK_FILE: path.join(workerRoot, 'worker.lock'),
    DOCKMASTER_AUTO_RUN_ONCE: '1',
  };
  const workerResult = run('/bin/bash', [path.join(repo, 'deploy/auto-apply.sh')], workerEnv);
  assert.equal(workerResult.status, 0, workerResult.stderr);
  assert.match(read(workerMasq), /address=\/worker\.test\/127\.0\.49\.49/);
  assert.match(read(workerHosts), /127\.0\.49\.49 worker\.test/);
  assert.match(read(workerActivity), /run start:/);
  assert.match(read(workerActivity), /run finish: success/);

  const idleResult = run('/bin/bash', [path.join(repo, 'deploy/auto-apply.sh')], workerEnv);
  assert.equal(idleResult.status, 0, idleResult.stderr);
  assert.match(read(workerActivity), /idle: no queued changes \(worker v2\)/);

  console.log('auto-apply fixtures passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
