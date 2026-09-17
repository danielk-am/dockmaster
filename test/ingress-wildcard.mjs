import assert from 'node:assert/strict';
import { CERTS, siteBlock, dnsLines, hostsLines, certPaths, fileStem, isWildcard, wildcardBase, validSiteName } from '../server/ingress-lib.mjs';

// The case this exists for: every Coolify service at <name>.m4.mac, served by
// one certificate and one DNS rule instead of a registration per service.
const wild = '*.m4.mac';
assert.equal(isWildcard(wild), true);
assert.equal(isWildcard('n8n.mac'), false);
assert.equal(wildcardBase(wild), 'm4.mac');
assert.equal(wildcardBase('n8n.mac'), 'n8n.mac');

// `*` stays out of file names and Caddy's tls arguments; mkcert's own
// `_wildcard.` spelling is used instead.
assert.equal(fileStem(wild), '_wildcard.m4.mac');
assert.deepEqual(certPaths(wild), { cert: `${CERTS}/_wildcard.m4.mac.pem`, key: `${CERTS}/_wildcard.m4.mac-key.pem` });

const block = siteBlock({ host: wild, port: 14443, tls: true });
assert.match(block, /^https:\/\/\*\.m4\.mac \{$/m);
assert.match(block, new RegExp(`\\ttls ${CERTS}/_wildcard\\.m4\\.mac\\.pem ${CERTS}/_wildcard\\.m4\\.mac-key\\.pem\\n`));
assert.equal(block.includes('*.m4.mac.pem'), false);
// The redirect must keep the name that was asked for, not the literal `*`.
assert.match(block, /^http:\/\/\*\.m4\.mac \{$/m);
assert.match(block, /\tredir https:\/\/\{host\}\{uri\} 308\n/);
assert.equal(block.includes('redir https://*'), false);

// One dnsmasq rule on the base answers every name under it, and it has to
// pass the root applier's queue check: address=/<valid hostname>/<alias>.
const dns = dnsLines(wild);
assert.deepEqual(dns, ['address=/m4.mac/127.0.49.49', 'address=/m4.mac/fd49::4949']);
const rootQueueLine = /^address=\/([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)\/(127\.0\.49\.49|fd49::4949)$/;
for (const line of dns) assert.match(line, rootQueueLine);
// /etc/hosts has no wildcards, so a wildcard contributes no hosts lines.
assert.deepEqual(hostsLines(wild), []);

// Regression: plain hosts generate exactly what they did before.
assert.deepEqual(certPaths('n8n.mac'), { cert: `${CERTS}/n8n.mac.pem`, key: `${CERTS}/n8n.mac-key.pem` });
assert.equal(fileStem('n8n.mac'), 'n8n.mac');
assert.deepEqual(dnsLines('n8n.mac'), ['address=/n8n.mac/127.0.49.49', 'address=/n8n.mac/fd49::4949']);
assert.deepEqual(hostsLines('n8n.mac'), ['127.0.49.49 n8n.mac', 'fd49::4949 n8n.mac']);
const plain = siteBlock({ host: 'n8n.mac', port: 14443, tls: true });
assert.match(plain, new RegExp(`\\ttls ${CERTS}/n8n\\.mac\\.pem ${CERTS}/n8n\\.mac-key\\.pem\\n`));
assert.match(plain, /\tredir https:\/\/n8n\.mac\{uri\} 308\n/);

// Names: a wildcard needs a real label under it. `*.mac` would sit directly
// under the TLD, and browsers refuse such a certificate.
assert.equal(validSiteName('browserless'), true);
assert.equal(validSiteName('*.m4'), true);
assert.equal(validSiteName('*'), false);
assert.equal(validSiteName('*.'), false);
assert.equal(validSiteName('a.*'), false);
assert.equal(validSiteName('*.*.m4'), false);
assert.equal(validSiteName('*.m4.x'), false);
assert.equal(validSiteName('-bad'), false);
assert.equal(validSiteName('a b'), false);

console.log('ingress-wildcard: ok');
