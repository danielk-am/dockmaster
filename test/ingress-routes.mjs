import assert from 'node:assert/strict';
import { normalizeRoutes, validRoute, siteBlock } from '../server/ingress-lib.mjs';

// The case this exists for: Coolify serves its UI on 8000 while its realtime
// socket dials the same hostname and expects /app/* on soketi (6001) and
// /terminal/ws on the terminal server (6002).
const coolify = [{ path: '/app/*', port: 6001 }, { path: '/terminal/ws*', port: 6002 }];
assert.deepEqual(normalizeRoutes(coolify), coolify);
assert.equal(validRoute({ path: '/app/*', port: 6001 }), true);

// A path is a Caddy matcher token, so it must start with / and carry nothing
// that could break out of the generated block.
assert.equal(validRoute({ path: 'app/*', port: 1 }), false);
assert.equal(validRoute({ path: '', port: 1 }), false);
assert.equal(validRoute({ path: '/a b', port: 1 }), false);
assert.equal(validRoute({ path: '/a\n}\nrespond "pwned"', port: 1 }), false);
assert.equal(validRoute({ path: '/a{$X}', port: 1 }), false);
assert.equal(validRoute({ path: '/a"b', port: 1 }), false);
assert.equal(validRoute({ path: '/' + 'a'.repeat(200), port: 1 }), false);
assert.equal(validRoute({ path: '/ok', port: 0 }), false);
assert.equal(validRoute({ path: '/ok', port: 65536 }), false);
assert.equal(validRoute({ path: '/ok', port: 1.5 }), false);
assert.equal(validRoute({ path: '/ok' }), false);
assert.equal(validRoute(null), false);
assert.equal(validRoute(['/ok', 80]), false);

// Normalizing drops the invalid rather than failing the whole write, keeps
// the first of a duplicated path, preserves order, and is bounded.
assert.deepEqual(
  normalizeRoutes([{ path: '/a', port: 1 }, { path: 'bad', port: 2 }, { path: '/b', port: 3 }]),
  [{ path: '/a', port: 1 }, { path: '/b', port: 3 }],
);
assert.deepEqual(
  normalizeRoutes([{ path: '/a', port: 1 }, { path: '/a', port: 999 }]),
  [{ path: '/a', port: 1 }],
);
assert.equal(normalizeRoutes(Array.from({ length: 50 }, (_, i) => ({ path: `/p${i}`, port: 90 }))).length, 20);
assert.deepEqual(normalizeRoutes(undefined), []);
assert.deepEqual(normalizeRoutes('/a'), []);
// Ports arriving as strings from a form still normalize to numbers.
assert.deepEqual(normalizeRoutes([{ path: '/a', port: '6001' }]), [{ path: '/a', port: 6001 }]);

// A tls upstream terminates TLS itself and routes by Host — a Coolify app
// behind the VM's proxy. It has to be dialled over https with verification
// off, because that certificate comes from Coolify's proxy, not from mkcert.
assert.deepEqual(normalizeRoutes([{ path: '/a', port: 1, tls: true }]), [{ path: '/a', port: 1, tls: true }]);
// Absent stays absent rather than becoming tls:false, so plain entries keep
// their exact on-disk shape.
assert.deepEqual(normalizeRoutes([{ path: '/a', port: 1 }]), [{ path: '/a', port: 1 }]);

// The regression that matters: a domain without tls must generate the byte
// string it generated before the flag existed.
const plain = siteBlock({ host: 'x.test', port: 3000 });
assert.match(plain, /\n\treverse_proxy 127\.0\.0\.1:3000\n/);
assert.equal(plain.includes('https://127.0.0.1'), false);
assert.equal(plain.includes('tls_insecure_skip_verify'), false);

const secured = siteBlock({ host: 'n8n.mac', port: 14443, tls: true });
assert.match(secured, /reverse_proxy https:\/\/127\.0\.0\.1:14443 \{/);
assert.match(secured, /\n\t\ttransport http \{\n\t\t\ttls_insecure_skip_verify\n\t\t\}\n/);
// Without this the Host-routing upstream answers 503: Caddy otherwise sends
// the upstream's own address as Host and no router matches it.
assert.match(secured, /\n\t\theader_up Host \{host\}\n\t\}/);
assert.equal(plain.includes('header_up'), false);

// Per-route tls is independent of the catch-all, so one domain can mix a
// plain local port with a Host-routed https upstream.
const mixed = siteBlock({ host: 'y.test', port: 14443, tls: true, routes: [{ path: '/app/*', port: 16001 }] });
assert.match(mixed, /handle \/app\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:16001\n\t\}/);
assert.match(mixed, /handle \{\n\t\treverse_proxy https:\/\/127\.0\.0\.1:14443 \{/);

console.log('ingress-routes: ok');
