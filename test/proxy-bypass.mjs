import assert from 'node:assert/strict';
import {
  bypassCovers,
  desiredBypass,
  parseBypassDomains,
  parseNetworkServices,
  parseScutilProxy,
  removeEntries,
  suffixEntry,
} from '../server/proxy-lib.mjs';

// Verbatim `scutil --proxy` from the machine that hit
// ERR_SOCKS_CONNECTION_FAILED on coolify.a8c: SOCKS on, .test exempt, the
// vanity suffixes not.
const SCUTIL = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.test
    1 : *.local
    2 : 169.254/16
    3 : localhost
    4 : 127.0.0.1
    5 : 192.168.50.0/24
  }
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 8080
  SOCKSProxy : 127.0.0.1
}`;

const active = parseScutilProxy(SCUTIL);
assert.equal(active.socks, true);
assert.equal(active.pac, false);
assert.equal(active.http, false);
assert.equal(active.socksServer, '127.0.0.1');
assert.equal(active.socksPort, '8080');
assert.deepEqual(active.exceptions, ['*.test', '*.local', '169.254/16', 'localhost', '127.0.0.1', '192.168.50.0/24']);

// A second array after ExceptionsList must not bleed into it.
const twoArrays = parseScutilProxy(`<dictionary> {
  ExceptionsList : <array> {
    0 : *.test
  }
  SupplementalMatchDomains : <array> {
    0 : corp.example
  }
  SOCKSEnable : 1
}`);
assert.deepEqual(twoArrays.exceptions, ['*.test']);

// The reported failure, and the domains that were fine, in one assertion set.
assert.equal(bypassCovers(active.exceptions, 'dockmaster.test'), true);
assert.equal(bypassCovers(active.exceptions, 'coolify.a8c'), false);
assert.equal(bypassCovers(active.exceptions, 'n8n.a8c'), false);
assert.equal(bypassCovers(active.exceptions, 'uip.mac'), false);
assert.equal(bypassCovers(active.exceptions, 'localhost'), true);

// A bare entry is a suffix too, and must match the name itself.
assert.equal(bypassCovers(['test'], 'foo.test'), true);
assert.equal(bypassCovers(['example.com'], 'example.com'), true);
assert.equal(bypassCovers(['example.com'], 'api.example.com'), true);
// Suffix matching stops at a label boundary, so a name cannot be exempted by
// a lookalike entry.
assert.equal(bypassCovers(['*.test'], 'nottest'), false);
assert.equal(bypassCovers(['*.test'], 'evil-test'), false);
assert.equal(bypassCovers(['example.com'], 'notexample.com'), false);
// CIDR and bare addresses are real bypass entries but cannot exempt a name.
assert.equal(bypassCovers(['169.254/16', '127.0.0.1'], 'coolify.a8c'), false);
assert.equal(bypassCovers([], 'coolify.a8c'), false);
assert.equal(bypassCovers(['*.a8c'], ''), false);

assert.equal(suffixEntry('a8c'), '*.a8c');
assert.equal(suffixEntry('.a8c'), '*.a8c');
assert.equal(suffixEntry('*.a8c'), '*.a8c');
assert.equal(suffixEntry('A8C'), '*.a8c');

// Adding never disturbs what was already there — the ordering of the existing
// entries is preserved and nothing is dropped.
const grown = desiredBypass(active.exceptions, ['*.test', '*.a8c', '*.mac', '*.1dr0']);
assert.equal(grown.changed, true);
assert.deepEqual(grown.added, ['*.a8c', '*.mac', '*.1dr0']);
assert.deepEqual(grown.list, [
  '*.test', '*.local', '169.254/16', 'localhost', '127.0.0.1', '192.168.50.0/24',
  '*.a8c', '*.mac', '*.1dr0',
]);
// Re-running is a no-op, so the UI can offer the fix without guarding on state.
const again = desiredBypass(grown.list, ['*.test', '*.a8c', '*.mac', '*.1dr0']);
assert.equal(again.changed, false);
assert.deepEqual(again.list, grown.list);
// Case differences are the same entry, not a duplicate.
assert.equal(desiredBypass(['*.A8C'], ['*.a8c']).changed, false);

// Removal is explicit and exact: a deregistered suffix goes, a foreign entry
// that merely looks similar stays.
const shrunk = removeEntries(grown.list, ['*.mac']);
assert.equal(shrunk.changed, true);
assert.equal(shrunk.list.includes('*.mac'), false);
assert.equal(shrunk.list.includes('*.a8c'), true);
assert.equal(shrunk.list.includes('192.168.50.0/24'), true);
assert.equal(removeEntries(shrunk.list, ['*.mac']).changed, false);
assert.equal(removeEntries(['*.corp'], ['*.corpx']).list.length, 1);

// networksetup output shapes.
assert.deepEqual(
  parseNetworkServices('An asterisk (*) denotes that a network service is disabled.\nThunderbolt Bridge\nWi-Fi\n'),
  [{ name: 'Thunderbolt Bridge', enabled: true }, { name: 'Wi-Fi', enabled: true }],
);
assert.deepEqual(
  parseNetworkServices('An asterisk (*) denotes that a network service is disabled.\n*Old VPN\nWi-Fi\n'),
  [{ name: 'Old VPN', enabled: false }, { name: 'Wi-Fi', enabled: true }],
);
assert.deepEqual(parseBypassDomains('*.local\n169.254/16\n'), ['*.local', '169.254/16']);
assert.deepEqual(parseBypassDomains("There aren't any bypass domains set on Wi-Fi.\n"), []);

console.log('proxy-bypass: ok');
