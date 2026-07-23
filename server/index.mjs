// Portside — local dev infrastructure dashboard server.
// Read-only views over listening ports, local domains, launchd services, and
// the DNS chain; the only mutations are kickstarting the user's own launchd
// agents and tailing their logs. Loopback only.
import express from 'express';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 4950);
const HOME = homedir();
const UID = process.getuid();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appVersion = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });

// ---------------------------------------------------------------- ports ----

// netstat sees every socket including root daemons' (lsof as a user cannot);
// -v adds the pid column. Merge in process names via ps.
async function listPorts() {
  const { stdout } = await run('netstat', ['-anv', '-p', 'tcp']);
  const rows = [];
  for (const line of stdout.split('\n')) {
    if (!/LISTEN/.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[3] || '';
    const m = local.match(/^(.*)\.(\d+)$/);
    if (!m) continue;
    // This macOS netstat prints a combined process:pid column after the
    // socket buffer stats — find it by shape rather than position.
    const procCol = cols.slice(6).find((c) => /^[^:]+:\d+$/.test(c));
    const pm = procCol ? procCol.match(/^(.+):(\d+)$/) : null;
    rows.push({
      proto: cols[0],
      address: m[1] === '*' ? '*' : m[1],
      port: Number(m[2]),
      pid: pm ? Number(pm[2]) : null,
      netstatName: pm ? pm[1] : null,
    });
  }
  const pids = [...new Set(rows.map((r) => r.pid).filter(Boolean))];
  const names = {};
  if (pids.length) {
    const { stdout: ps } = await run('ps', ['-o', 'pid=,user=,comm=', '-p', pids.join(',')]);
    for (const line of ps.split('\n')) {
      const pm = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (pm) names[Number(pm[1])] = { user: pm[2], command: path.basename(pm[3]) };
    }
  }
  const out = rows.map((r) => ({
    ...r,
    process: names[r.pid]?.command || r.netstatName || null,
    user: r.pid ? names[r.pid]?.user || null : null,
  }));
  // Collision flag: same port held by more than one distinct pid (wildcard +
  // specific binds coexisting — exactly the Studio/Caddy arrangement).
  const byPort = {};
  out.forEach((r) => { (byPort[r.port] = byPort[r.port] || new Set()).add(r.pid); });
  out.forEach((r) => { r.shared = byPort[r.port].size > 1; });
  return out.sort((a, b) => a.port - b.port);
}

// -------------------------------------------------------------- domains ----

async function gatherDomainSources() {
  const domains = new Map(); // name -> { sources: [], expected: [] }
  const add = (name, source, expected) => {
    if (!domains.has(name)) domains.set(name, { name, sources: [], expected: [] });
    const d = domains.get(name);
    if (!d.sources.includes(source)) d.sources.push(source);
    if (expected && !d.expected.includes(expected)) d.expected.push(expected);
  };
  try {
    const hosts = await readFile('/etc/hosts', 'utf8');
    for (const line of hosts.split('\n')) {
      const m = line.match(/^\s*([0-9a-fA-F:.]+)\s+([^\s#]+)/);
      if (m && !['localhost', 'broadcasthost'].includes(m[2])) add(m[2], '/etc/hosts', m[1]);
    }
  } catch { /* unreadable */ }
  for (const conf of ['/opt/homebrew/etc/dnsmasq.conf']) {
    try {
      const text = await readFile(conf, 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*address=\/([^/]+)\/(.+)$/);
        if (m) add(m[1].startsWith('.') ? `*${m[1]}` : m[1].includes('.') ? m[1] : `*.${m[1]}`, 'dnsmasq', m[2]);
      }
    } catch { /* absent */ }
  }
  try {
    for (const f of await readdir('/etc/resolver')) add(`*.${f}`, `/etc/resolver/${f}`, null);
  } catch { /* absent */ }
  return [...domains.values()];
}

async function resolveDomain(name) {
  // Wildcard rows probe a synthetic member so the wildcard's behavior shows.
  const probe = name.startsWith('*.') ? `portside-probe${name.slice(1)}` : name;
  const sys = await run('dscacheutil', ['-q', 'host', '-a', 'name', probe]);
  const a = sys.stdout.match(/ip_address:\s*(\S+)/)?.[1] || null;
  const aaaa = sys.stdout.match(/ipv6_address:\s*(\S+)/)?.[1] || null;
  const masq = await run('dig', ['+short', '+time=1', '+tries=1', probe, '@127.0.0.1']);
  const dnsmasqAnswer = masq.ok ? masq.stdout.trim().split('\n')[0] || null : null;
  return { system: { a, aaaa }, dnsmasq: dnsmasqAnswer };
}

// -------------------------------------------------------------- launchd ----

const OWNED = /^(am\.danielk\.|com\.danielkam\.|dev\.1dr0\.)/;

async function plistToJson(file) {
  const { ok, stdout } = await run('plutil', ['-convert', 'json', '-o', '-', file]);
  if (!ok) return null;
  try { return JSON.parse(stdout); } catch { return null; }
}

async function listLaunchd() {
  const out = [];
  const scan = async (dir, domain) => {
    let files = [];
    try { files = await readdir(dir); } catch { return; }
    for (const f of files) {
      if (!f.endsWith('.plist')) continue;
      const meta = await plistToJson(path.join(dir, f));
      const label = meta?.Label || f.replace(/\.plist$/, '');
      out.push({
        label,
        domain,
        file: path.join(dir, f),
        owned: OWNED.test(label),
        keepAlive: !!meta?.KeepAlive,
        runAtLoad: !!meta?.RunAtLoad,
        interval: meta?.StartInterval || null,
        log: meta?.StandardOutPath || null,
        disabled: f.includes('.disabled') || f.includes('.retired'),
      });
    }
  };
  await scan(path.join(HOME, 'Library/LaunchAgents'), 'user');
  await scan('/Library/LaunchDaemons', 'system');
  // State: only the user domain is inspectable without sudo.
  const { stdout } = await run('launchctl', ['list']);
  const state = {};
  for (const line of stdout.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 3) state[cols[2]] = { pid: cols[0] === '-' ? null : Number(cols[0]), lastExit: Number(cols[1]) };
  }
  return out.map((j) => ({
    ...j,
    running: j.domain === 'user' ? !!state[j.label]?.pid : null,
    pid: j.domain === 'user' ? state[j.label]?.pid ?? null : null,
    lastExit: j.domain === 'user' ? state[j.label]?.lastExit ?? null : null,
  }));
}

// ------------------------------------------------------------ dns chain ----

async function dnsChain() {
  const { stdout } = await run('scutil', ['--dns']);
  const resolvers = [];
  let current = null;
  for (const line of stdout.split('\n')) {
    const r = line.match(/^resolver #(\d+)/);
    if (r) { current = { id: Number(r[1]), nameservers: [], domain: null, flags: null }; resolvers.push(current); continue; }
    if (!current) continue;
    const ns = line.match(/nameserver\[\d+\]\s*:\s*(\S+)/);
    if (ns) current.nameservers.push(ns[1]);
    const dm = line.match(/domain\s*:\s*(\S+)/);
    if (dm) current.domain = dm[1];
    const fl = line.match(/flags\s*:\s*(.+)$/);
    if (fl && !current.flags) current.flags = fl[1].trim();
  }
  // mDNS/reverse-arpa scopes have no nameservers — noise here.
  const scoped = resolvers.filter((r) => r.domain && r.nameservers.length);
  const nextdns = (await run('pgrep', ['-x', 'NextDNS'])).ok || (await run('pgrep', ['-if', 'nextdns'])).ok;
  const dnsmasq = (await run('pgrep', ['-x', 'dnsmasq'])).ok;
  return { scoped, defaultNameservers: resolvers.find((r) => !r.domain)?.nameservers || [], nextdns, dnsmasq };
}

// ------------------------------------------------------------------ app ----

const app = express();
app.use(express.json());

app.get('/api/overview', async (_req, res) => {
  const [ports, launchd, dns] = await Promise.all([listPorts(), listLaunchd(), dnsChain()]);
  const domains = await gatherDomainSources();
  res.json({
    appVersion,
    counts: {
      ports: ports.length,
      sharedPorts: [...new Set(ports.filter((p) => p.shared).map((p) => p.port))].length,
      domains: domains.length,
      services: launchd.length,
      running: launchd.filter((j) => j.running).length,
    },
    dns,
  });
});

app.get('/api/ports', async (_req, res) => res.json(await listPorts()));

app.get('/api/domains', async (_req, res) => {
  const [sources, ports] = await Promise.all([gatherDomainSources(), listPorts()]);
  const listenersFor = (ip) =>
    ports
      .filter((p) => p.address === ip || p.address === '*' || (ip && ip.startsWith('127.') && p.address === '127.0.0.1' && ip === '127.0.0.1'))
      .filter((p) => [80, 443, 8881, 8882, 4949, 4950, 8082].includes(p.port))
      .map((p) => `${p.port}/${p.process || '?'}`);
  // Probe every domain concurrently — dscacheutil on a non-answering name
  // can take seconds, and serially that reads as a hung page.
  const out = await Promise.all(
    sources.map(async (d) => {
      const r = await resolveDomain(d.name);
      const divergent = !!(r.dnsmasq && r.system.a && r.dnsmasq !== r.system.a);
      const dead = !!(r.system.a === null && r.dnsmasq === null);
      return { ...d, ...r, divergent, dead, listeners: r.system.a ? listenersFor(r.system.a) : [] };
    })
  );
  res.json(out);
});

app.get('/api/launchd', async (_req, res) => res.json(await listLaunchd()));

app.post('/api/launchd/:label/kickstart', async (req, res) => {
  const { label } = req.params;
  if (!OWNED.test(label)) return res.status(403).json({ error: 'Only your own am.danielk./com.danielkam./dev.1dr0. agents can be kickstarted.' });
  const jobs = await listLaunchd();
  const job = jobs.find((j) => j.label === label && j.domain === 'user');
  if (!job) return res.status(404).json({ error: 'Not a user-domain agent (system daemons need sudo in a terminal).' });
  const r = await run('launchctl', ['kickstart', '-k', `gui/${UID}/${label}`]);
  res.json({ ok: r.ok, stderr: r.stderr.trim() });
});

app.get('/api/launchd/:label/log', async (req, res) => {
  const jobs = await listLaunchd();
  const job = jobs.find((j) => j.label === req.params.label);
  if (!job?.log) return res.status(404).json({ error: 'No StandardOutPath declared.' });
  const resolved = path.resolve(job.log);
  const allowed = [path.join(HOME, '.local'), path.join(HOME, 'Library/Logs'), '/Library/Logs', '/tmp', '/private/tmp'];
  if (!allowed.some((p) => resolved.startsWith(p + path.sep) || resolved === p)) {
    return res.status(403).json({ error: `Log path outside readable roots: ${resolved}` });
  }
  if (!existsSync(resolved)) return res.json({ path: resolved, lines: [] });
  const r = await run('tail', ['-n', '120', resolved]);
  res.json({ path: resolved, lines: r.stdout.split('\n') });
});

app.get('/api/dns', async (_req, res) => res.json(await dnsChain()));

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));

app.listen(PORT, '127.0.0.1', () => console.log(`Portside v${appVersion} on http://127.0.0.1:${PORT}`));
