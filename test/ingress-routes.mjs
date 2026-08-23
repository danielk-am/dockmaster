import assert from 'node:assert/strict';
import { normalizeRoutes, validRoute } from '../server/ingress-lib.mjs';

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

console.log('ingress-routes: ok');
