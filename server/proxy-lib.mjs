// System proxy reach for the Local Ingress.
//
// A registered domain can be perfectly served — cert minted, hosts line
// applied, Caddy answering on 127.0.49.49 — and still fail in the browser
// with ERR_SOCKS_CONNECTION_FAILED, because macOS hands the hostname to the
// system proxy before any of that matters. The proxy resolves names on the
// far side of the tunnel, where a name that only exists in /etc/hosts cannot
// exist, so the request dies before it reaches the loopback.
//
// The bypass list is what exempts a name. It is keyed by SUFFIX, which is the
// same granularity as the vanity-TLD registry: one `*.<tld>` entry makes every
// current and future site under that suffix reachable. So the required bypass
// set is derived from the TLD registry, exactly the way resolver files are.
//
// Unlike hosts/dnsmasq/resolver, this needs no root: `networksetup` accepts
// proxy writes from any admin-group member. The privileged queue stays as the
// fallback for the case where it does not.
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';

const NETWORKSETUP = '/usr/sbin/networksetup';
const SCUTIL = '/usr/sbin/scutil';

const run = (cmd, args, timeout = 6000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') });
  });
});

// ---------------------------------------------------------------- parsing ----

// `scutil --proxy` is the EFFECTIVE configuration — the merge of every
// network service, which is what a browser actually consults. The per-service
// `networksetup` reads below are the writable surface; these are the truth.
export const parseScutilProxy = (text) => {
  const scalar = (key) => {
    const m = String(text).match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm'));
    return m ? m[1] : null;
  };
  const enabled = (key) => scalar(key) === '1';
  const exceptions = [];
  // ExceptionsList is a numbered array block; take entries until the closing
  // brace so a later array (SupplementalMatchDomains) cannot bleed in.
  const block = String(text).match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\n\s*\}/);
  if (block) {
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s*\d+\s*:\s*(\S+)\s*$/);
      if (m) exceptions.push(m[1]);
    }
  }
  return {
    exceptions,
    socks: enabled('SOCKSEnable'),
    http: enabled('HTTPEnable'),
    https: enabled('HTTPSEnable'),
    pac: enabled('ProxyAutoConfigEnable'),
    pacUrl: scalar('ProxyAutoConfigURLString'),
    socksServer: scalar('SOCKSProxy'),
    socksPort: scalar('SOCKSPort'),
  };
};

// The header line is prose, not a service. A leading asterisk marks a service
// that is switched off; it still holds settings and can be switched back on,
// so it is worth writing to.
export const parseNetworkServices = (text) => String(text)
  .split('\n')
  .slice(1)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => (line.startsWith('*')
    ? { name: line.slice(1).trim(), enabled: false }
    : { name: line, enabled: true }))
  .filter((service) => service.name);

// An unset list prints a sentence rather than an empty result.
export const parseBypassDomains = (text) => {
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && /aren't any|there are no/i.test(lines[0])) return [];
  return lines.filter((line) => !/^there/i.test(line));
};

// --------------------------------------------------------------- matching ----

// A CIDR block or bare address can never exempt a hostname, so those entries
// are inert here even though they are legitimate bypass entries.
const hostnameEntry = (entry) => {
  const value = String(entry || '').trim().toLowerCase();
  if (!value || value.includes('/') || isIP(value) !== 0) return null;
  return value.startsWith('*.') ? value.slice(2) : value;
};

// macOS and Chrome both treat a bypass entry as a suffix: `test` and `*.test`
// each exempt `foo.test`, and an entry also matches the bare name itself.
export const bypassCovers = (exceptions, host) => {
  const name = String(host || '').trim().toLowerCase();
  if (!name) return false;
  return (exceptions || []).some((entry) => {
    const suffix = hostnameEntry(entry);
    if (!suffix) return false;
    return name === suffix || name.endsWith(`.${suffix}`);
  });
};

export const suffixEntry = (tld) => `*.${String(tld).trim().toLowerCase().replace(/^\*?\.?/, '')}`;

// Only ever ADD. A bypass list is shared with whatever else configured the
// machine, and silently dropping someone else's entry to make ours tidy is
// how a VPN or a corporate tool quietly stops working. Removal is explicit
// and targets one exact string (see removeEntries).
export const desiredBypass = (current, required) => {
  const list = [...(current || [])];
  const present = new Set(list.map((entry) => String(entry).trim().toLowerCase()));
  const added = [];
  for (const entry of required || []) {
    const value = String(entry).trim().toLowerCase();
    if (!value || present.has(value)) continue;
    present.add(value);
    list.push(value);
    added.push(value);
  }
  return { list, added, changed: added.length > 0 };
};

export const removeEntries = (current, drop) => {
  const gone = new Set((drop || []).map((entry) => String(entry).trim().toLowerCase()));
  const list = (current || []).filter((entry) => !gone.has(String(entry).trim().toLowerCase()));
  return { list, changed: list.length !== (current || []).length };
};

// ----------------------------------------------------------------- system ----

export const readProxyState = async () => {
  const [scutil, services] = await Promise.all([
    run(SCUTIL, ['--proxy']),
    run(NETWORKSETUP, ['-listallnetworkservices']),
  ]);
  const active = parseScutilProxy(scutil.stdout);
  const parsed = parseNetworkServices(services.stdout);
  const configured = await Promise.all(parsed.map(async (service) => {
    const bypass = await run(NETWORKSETUP, ['-getproxybypassdomains', service.name]);
    return { ...service, bypass: bypass.ok ? parseBypassDomains(bypass.stdout) : [], readable: bypass.ok };
  }));
  return { ...active, on: active.socks || active.http || active.https || active.pac, services: configured };
};

// networksetup replaces the whole list in one call, so the read-modify-write
// happens here and the result is read back rather than assumed.
export const writeBypass = async (serviceName, list) => {
  const args = ['-setproxybypassdomains', serviceName, ...(list.length ? list : ['Empty'])];
  const wrote = await run(NETWORKSETUP, args);
  if (!wrote.ok) {
    return { ok: false, error: (wrote.stderr || wrote.stdout).trim() || 'networksetup refused the change.' };
  }
  const back = await run(NETWORKSETUP, ['-getproxybypassdomains', serviceName]);
  const applied = back.ok ? parseBypassDomains(back.stdout) : [];
  const expected = new Set(list.map((entry) => entry.toLowerCase()));
  const missing = [...expected].filter((entry) => !applied.some((item) => item.toLowerCase() === entry));
  if (missing.length) {
    return { ok: false, error: `Readback is missing ${missing.join(', ')}.`, applied };
  }
  return { ok: true, applied };
};
