// Dockmaster — local dev infrastructure dashboard server.
// Views over listening ports, local domains, launchd services, and the DNS
// chain, plus management: the ingress domain registry (add/edit/remove),
// SIGTERM on your own listeners, and editing/kickstarting your own launchd
// agents. Loopback only.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALIAS_IP,
  ALIAS_IP6,
  CERTS,
  MKCERT,
  ensureDirs,
  readRegistry,
  refreshDnsPending,
  regenerate,
  writeRegistry,
} from './ingress-lib.mjs';

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
  const add = (name, source, expected, extra) => {
    if (!domains.has(name)) domains.set(name, { name, sources: [], expected: [] });
    const d = domains.get(name);
    if (!d.sources.includes(source)) d.sources.push(source);
    if (expected && !d.expected.includes(expected)) d.expected.push(expected);
    if (extra) Object.assign(d, extra);
  };
  try {
    const hosts = await readFile('/etc/hosts', 'utf8');
    for (const line of hosts.split('\n')) {
      const m = line.match(/^\s*([0-9a-fA-F:.]+)\s+([^\s#]+)/);
      if (m && !['localhost', 'broadcasthost'].includes(m[2])) add(m[2], '/etc/hosts', m[1], { inHosts: true });
    }
  } catch { /* unreadable */ }
  for (const conf of ['/opt/homebrew/etc/dnsmasq.conf']) {
    try {
      const text = await readFile(conf, 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*address=\/([^/]+)\/(.+)$/);
        // The raw registration key (m[1]) is what an edit must target — the
        // display name is a wildcard rendering of it.
        if (m) add(m[1].startsWith('.') ? `*${m[1]}` : m[1].includes('.') ? m[1] : `*.${m[1]}`, 'dnsmasq', m[2], { dnsmasqKey: m[1] });
      }
    } catch { /* absent */ }
  }
  try {
    for (const f of await readdir('/etc/resolver')) add(`*.${f}`, `/etc/resolver/${f}`, null, { resolverFile: f });
  } catch { /* absent */ }
  return [...domains.values()];
}

async function resolveDomain(name) {
  // Wildcard rows probe a synthetic member so the wildcard's behavior shows.
  const probe = name.startsWith('*.') ? `dockmaster-probe${name.slice(1)}` : name;
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

// -------------------------------------------------------------- ingress ----
// The management half (absorbed from Local Ingress): the domain registry in
// ~/.local/share/local-ingress/ drives generated Caddy site blocks + mkcert
// certs, all user-owned; the am.danielk.local-ingress root daemon runs
// `caddy run --watch` over them, so registry changes apply with ZERO
// privileges. Only new dnsmasq/hosts lines stay privileged — staged into
// pending files, applied by deploy/apply-dns.sh.

const tcpProbe = (host, port) =>
  new Promise((resolve) => {
    const sock = createConnection({ host, port, timeout: 1200 });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });

const ingressDnsState = async (host) => {
  const r = await run('dscacheutil', ['-q', 'host', '-a', 'name', host]);
  return r.stdout.includes(ALIAS_IP) ? 'ok' : 'pending';
};

async function ingressState() {
  ensureDirs();
  const reg = readRegistry();
  const pending = refreshDnsPending();
  const ingressUp = await tcpProbe(ALIAS_IP, 443);
  const domains = await Promise.all(
    reg.domains.map(async (d) => ({
      ...d,
      cert: existsSync(path.join(CERTS, `${d.host}.pem`)),
      dns: await ingressDnsState(d.host),
      upstream: (await tcpProbe('127.0.0.1', d.port)) ? 'up' : 'down',
      url: `https://${d.host}`,
    }))
  );
  return {
    ingress: { up: ingressUp, aliasIp: ALIAS_IP, aliasIp6: ALIAS_IP6 },
    dnsPending: pending,
    applyDnsCommand: 'sudo bash ~/ai/repos/dockmaster/deploy/apply-dns.sh',
    installCommand: 'sudo bash ~/ai/repos/dockmaster/deploy/install.sh',
    domains,
  };
}

// ------------------------------------------------------------------ app ----

const app = express();
app.use(express.json());

app.get('/api/ingress', async (_req, res) => res.json(await ingressState()));

app.post('/api/ingress/domains', async (req, res) => {
  // The UI sends the bare NAME; .test is the fixed suffix (Daniel's nit —
  // never type .test on every line). Full hosts are tolerated for the API.
  const name = String(req.body?.name ?? req.body?.host ?? '').trim().toLowerCase().replace(/\.test$/, '');
  const host = `${name}.test`;
  const port = Number(req.body?.port);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return res.status(400).json({ error: 'Name must be letters/digits/hyphens (the .test suffix is automatic).' });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Upstream port must be 1–65535.' });
  }
  const reg = readRegistry();
  if (reg.domains.some((d) => d.host === host)) {
    return res.status(409).json({ error: `${host} is already registered.` });
  }
  const mk = await run(MKCERT, [
    '-cert-file', path.join(CERTS, `${host}.pem`),
    '-key-file', path.join(CERTS, `${host}-key.pem`),
    host,
  ]);
  if (!mk.ok) return res.status(500).json({ error: `mkcert failed: ${mk.stderr.slice(0, 300)}` });
  reg.domains.push({ host, port });
  reg.domains.sort((a, b) => a.host.localeCompare(b.host));
  writeRegistry(reg);
  regenerate();
  res.json({ ok: true, host });
});

// Edit = repoint an existing domain at a different upstream port. The host
// (and so its cert and DNS lines) is unchanged — the registry write plus
// regenerate is the whole job, applied live by the watching daemon.
app.patch('/api/ingress/domains/:host', (req, res) => {
  const host = String(req.params.host).toLowerCase();
  const port = Number(req.body?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Upstream port must be 1–65535.' });
  }
  const reg = readRegistry();
  const entry = reg.domains.find((d) => d.host === host);
  if (!entry) return res.status(404).json({ error: 'Not registered.' });
  entry.port = port;
  writeRegistry(reg);
  regenerate();
  res.json({ ok: true, host, port });
});

app.delete('/api/ingress/domains/:host', (req, res) => {
  const host = String(req.params.host).toLowerCase();
  const reg = readRegistry();
  if (!reg.domains.some((d) => d.host === host)) return res.status(404).json({ error: 'Not registered.' });
  reg.domains = reg.domains.filter((d) => d.host !== host);
  writeRegistry(reg);
  for (const f of [`${host}.pem`, `${host}-key.pem`]) {
    try { rmSync(path.join(CERTS, f)); } catch { /* already gone */ }
  }
  regenerate();
  res.json({ ok: true });
});

// ------------------------------------------------- observed-domain edits ----
// The observed domains (hosts file, dnsmasq rules, resolver files) are
// root-owned, so the server never touches them — edits are STAGED into a
// user-owned queue and applied by one privileged run of apply-edits.sh,
// same doctrine as the ingress DNS lines.

const EDITS_FILE = path.join(HOME, '.local/share/local-ingress/observed-edits.json');
const readEdits = () => { try { return JSON.parse(readFileSync(EDITS_FILE, 'utf8')); } catch { return []; } };
const writeEdits = (edits) => writeFileSync(EDITS_FILE, JSON.stringify(edits, null, 2) + '\n');
const APPLY_EDITS_COMMAND = 'sudo bash ~/ai/repos/dockmaster/deploy/apply-edits.sh';

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const IP_RE = /^((\d{1,3}\.){3}\d{1,3}|[0-9a-f:]+)$/i;
const RESOLVER_RE = /^[a-z0-9._-]+$/i;

// One staged op per target (last wins) — the queue is intent, not history.
const editTarget = (e) => e.kind.startsWith('hosts') ? `hosts:${e.name}` : e.kind.startsWith('dnsmasq') ? `dnsmasq:${e.key}` : `resolver:${e.file}`;

app.get('/api/observed/edits', (_req, res) => res.json({ edits: readEdits(), applyCommand: APPLY_EDITS_COMMAND }));

app.post('/api/observed/edits', (req, res) => {
  const { kind, name, ip, key, file, content } = req.body || {};
  const edit = { id: randomUUID(), kind };
  if (kind === 'hosts-set' || kind === 'hosts-del') {
    if (!HOSTNAME_RE.test(String(name || ''))) return res.status(400).json({ error: 'Bad hostname.' });
    edit.name = String(name).toLowerCase();
    if (kind === 'hosts-set') {
      if (!IP_RE.test(String(ip || ''))) return res.status(400).json({ error: 'Bad IP address.' });
      edit.ip = String(ip);
    }
  } else if (kind === 'dnsmasq-set' || kind === 'dnsmasq-del') {
    if (!/^\.?[a-z0-9.-]+$/i.test(String(key || ''))) return res.status(400).json({ error: 'Bad dnsmasq domain key.' });
    edit.key = String(key);
    if (kind === 'dnsmasq-set') {
      if (!IP_RE.test(String(ip || ''))) return res.status(400).json({ error: 'Bad IP address.' });
      edit.ip = String(ip);
    }
  } else if (kind === 'resolver-write' || kind === 'resolver-del') {
    if (!RESOLVER_RE.test(String(file || ''))) return res.status(400).json({ error: 'Bad resolver file name.' });
    edit.file = String(file);
    if (kind === 'resolver-write') {
      if (typeof content !== 'string' || !content.trim() || content.length > 4000) return res.status(400).json({ error: 'Resolver content must be non-empty text (≤4000 chars).' });
      edit.content = content.endsWith('\n') ? content : content + '\n';
    }
  } else {
    return res.status(400).json({ error: 'Unknown edit kind.' });
  }
  const edits = readEdits().filter((e) => editTarget(e) !== editTarget(edit));
  edits.push(edit);
  writeEdits(edits);
  res.json({ ok: true, edit });
});

app.delete('/api/observed/edits/:id', (req, res) => {
  const edits = readEdits();
  const next = edits.filter((e) => e.id !== req.params.id);
  if (next.length === edits.length) return res.status(404).json({ error: 'Not staged.' });
  writeEdits(next);
  res.json({ ok: true });
});

// Resolver files are root-owned but world-readable — served for the editor.
app.get('/api/observed/resolver/:file', async (req, res) => {
  const file = String(req.params.file);
  if (!RESOLVER_RE.test(file)) return res.status(400).json({ error: 'Bad resolver file name.' });
  try {
    res.json({ file, content: await readFile(path.join('/etc/resolver', file), 'utf8') });
  } catch {
    res.status(404).json({ error: 'Unreadable or missing.' });
  }
});

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

// Port management: SIGTERM a listener you own. Root/system processes are
// refused — those are sudo-in-a-terminal territory.
app.post('/api/ports/kill', async (req, res) => {
  const pid = Number(req.body?.pid);
  if (!Number.isInteger(pid) || pid <= 1) return res.status(400).json({ error: 'Bad pid.' });
  const { stdout } = await run('ps', ['-o', 'uid=,comm=', '-p', String(pid)]);
  const m = stdout.trim().match(/^(\d+)\s+(.*)$/);
  if (!m) return res.status(404).json({ error: 'Process not found.' });
  if (Number(m[1]) !== process.getuid()) return res.status(403).json({ error: 'Not your process — root/system listeners need sudo in a terminal.' });
  try {
    process.kill(pid, 'SIGTERM');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// Launchd plist viewer: the declared file. `editable` tells the UI whether
// the save path below will accept it (user-domain, under ~/Library/LaunchAgents).
const AGENTS_DIR = path.join(HOME, 'Library/LaunchAgents');
const plistEditable = (job) => job.domain === 'user' && path.resolve(job.file).startsWith(AGENTS_DIR + path.sep);

app.get('/api/launchd/:label/plist', async (req, res) => {
  const jobs = await listLaunchd();
  const job = jobs.find((j) => j.label === req.params.label);
  if (!job) return res.status(404).json({ error: 'Unknown label.' });
  const r = await run('cat', [job.file]);
  res.json({ path: job.file, content: r.stdout, lines: r.stdout.split('\n'), editable: plistEditable(job) });
});

// Plist editing: user agents only. The write is validate-then-swap — plutil
// lints the candidate before it replaces the live file, so a bad edit can
// never leave launchd pointed at broken XML. System daemons stay sudo-in-a-
// terminal territory.
app.put('/api/launchd/:label/plist', async (req, res) => {
  const content = String(req.body?.content ?? '');
  if (!content.trim()) return res.status(400).json({ error: 'Empty plist.' });
  const jobs = await listLaunchd();
  const job = jobs.find((j) => j.label === req.params.label);
  if (!job) return res.status(404).json({ error: 'Unknown label.' });
  if (!plistEditable(job)) return res.status(403).json({ error: 'Only user agents under ~/Library/LaunchAgents are editable here — system daemons need sudo in a terminal.' });
  const tmp = `${job.file}.dockmaster-tmp`;
  const { writeFile, rename } = await import('node:fs/promises');
  await writeFile(tmp, content, 'utf8');
  const lint = await run('plutil', ['-lint', tmp]);
  // -lint alone accepts legacy OpenStep scraps (a bare string is a "valid
  // plist") — also require it to convert to a dict that still declares the
  // same Label, so a save can never leave launchd a structurally empty file.
  const meta = lint.ok ? await plistToJson(tmp) : null;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    rmSync(tmp, { force: true });
    return res.status(400).json({ error: `Invalid plist: ${lint.ok ? 'not a dictionary of launchd keys.' : (lint.stderr || lint.stdout).trim().slice(0, 300)}` });
  }
  if (meta.Label !== job.label) {
    rmSync(tmp, { force: true });
    return res.status(400).json({ error: `Label must stay "${job.label}" (found ${JSON.stringify(meta.Label ?? null)}).` });
  }
  await rename(tmp, job.file);
  res.json({ ok: true, path: job.file });
});

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));

app.listen(PORT, '127.0.0.1', () => console.log(`Dockmaster v${appVersion} on http://127.0.0.1:${PORT}`));
