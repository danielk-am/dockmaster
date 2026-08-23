// Dockmaster — local dev infrastructure dashboard server.
// Views over listening ports, local domains, launchd services, and the DNS
// chain, plus management: the ingress domain registry (add/edit/remove),
// SIGTERM on your own listeners, and editing/kickstarting your own launchd
// agents. Loopback only.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir, rename } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { aiChatClientConfig, createAiBridgeRegistry } from './ai-bridge-config.mjs';
import { discoverDockerWebServices } from './docker-lib.mjs';
import {
  bypassCovers,
  desiredBypass,
  readProxyState,
  removeEntries,
  suffixEntry,
  writeBypass,
} from './proxy-lib.mjs';
import {
  createRemoteProvider,
  remoteProviderOptionsFromEnvironment,
  RemoteProviderError,
} from './remote-provider-lib.mjs';
import {
  ALIAS_IP,
  ALIAS_IP6,
  BUILTIN_TLDS,
  CERTS,
  MKCERT,
  RESOLVER_DIR,
  STATE as INGRESS_STATE,
  ensureDirs,
  readRegistry,
  readTlds,
  refreshDnsPending,
  regenerate,
  resolverSeed,
  writeRegistry,
  writeTlds,
} from './ingress-lib.mjs';

const PORT = Number(process.env.PORT || 4950);
const HOME = homedir();
const UID = process.getuid();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appVersion = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
const aiRelays = createAiBridgeRegistry();
const remoteProviderOptions = remoteProviderOptionsFromEnvironment();
const remoteProvider = remoteProviderOptions
  ? createRemoteProvider(remoteProviderOptions)
  : Object.freeze({
      request() {
        return Promise.reject(new RemoteProviderError(
          'NOT_CONFIGURED',
          'Remote provider is not configured.',
        ));
      },
    });

// Every sudo command the UI hands out is derived from where this repo
// actually lives, so repo moves do not leave this command pointing at a
// retired location.
const REPO = path.resolve(__dirname, '..');
const sudoCommand = (script) => `sudo bash ${path.join(REPO, 'deploy', script).replace(HOME, '~')}`;
const AUTO_APPLY_LABEL = 'am.danielk.local-ingress-auto-apply';
const AUTO_APPLY_LOG = `/Library/Logs/${AUTO_APPLY_LABEL}.log`;
const AUTO_APPLY_SUPPORT = '/Library/Application Support/Dockmaster/auto-apply.sh';
const AUTO_APPLY_RETENTION = `/etc/newsyslog.d/${AUTO_APPLY_LABEL}.conf`;

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });

// A registered system-domain job remains visible while idle, so launchctl
// print is a stronger signal than merely finding its plist on disk.
const autoApplyEnabled = async () => (
  await run('/bin/launchctl', ['print', `system/${AUTO_APPLY_LABEL}`], { timeout: 2000 })
).ok;

const autoApplyActivity = () => {
  const files = [];
  for (let index = 30; index >= 0; index -= 1) files.push(`${AUTO_APPLY_LOG}.${index}`);
  files.push(AUTO_APPLY_LOG);
  const lines = files.flatMap((file) => {
    try {
      return readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  });
  let workerVersion = null;
  try {
    const worker = readFileSync(AUTO_APPLY_SUPPORT, 'utf8');
    if (worker.includes('AUTO_APPLY_WORKER_VERSION=2')) workerVersion = 2;
    else if (worker.trim()) workerVersion = 1;
  } catch { /* not installed */ }
  let orphanedClaims = 0;
  try {
    orphanedClaims = readdirSync(INGRESS_STATE).filter((file) => (
      /^(dns-pending\.conf|hosts-pending\.conf|observed-edits\.json)\.applying\.[0-9]+$/.test(file)
    )).length;
  } catch { /* state not seeded */ }
  return {
    lines: lines.slice(-200),
    logPath: AUTO_APPLY_LOG,
    installCommand: sudoCommand('install.sh'),
    retentionDays: existsSync(AUTO_APPLY_RETENTION) ? 30 : null,
    workerVersion,
    orphanedClaims,
  };
};

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
      // foo.plist is live; foo.plist.disabled / .retired-… is parked — launchd
      // skips it at login, but it still lists here so it can be re-enabled.
      const m = f.match(/^(.+\.plist)(\.[A-Za-z0-9._-]+)?$/);
      if (!m) continue;
      const meta = await plistToJson(path.join(dir, f));
      const label = meta?.Label || m[1].replace(/\.plist$/, '');
      out.push({
        label,
        domain,
        file: path.join(dir, f),
        owned: OWNED.test(label),
        keepAlive: !!meta?.KeepAlive,
        runAtLoad: !!meta?.RunAtLoad,
        interval: meta?.StartInterval || null,
        log: meta?.StandardOutPath || null,
        disabled: !!m[2],
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
// privileges. Privileged DNS/hosts/resolver changes go through fixed queue
// files; the optional root auto-apply job validates and applies them.

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
  const [ingressUp, autoApply, proxy] = await Promise.all([
    tcpProbe(ALIAS_IP, 443),
    autoApplyEnabled(),
    proxyState(),
  ]);
  // One launchd snapshot serves every row's linked-service state plus the
  // list of linkable agents for the UI's picker.
  const jobs = (await listLaunchd()).filter((j) => j.domain === 'user');
  const agentFor = (label) => jobs.find((j) => j.label === label) || null;
  const domains = await Promise.all(
    reg.domains.map(async (d) => {
      const agent = d.service ? agentFor(d.service) : null;
      return {
        ...d,
        cert: existsSync(path.join(CERTS, `${d.host}.pem`)),
        dns: await ingressDnsState(d.host),
        upstream: (await tcpProbe('127.0.0.1', d.port)) ? 'up' : 'down',
        url: `https://${d.host}`,
        // 'shadowed' is the browser-only failure: everything below the
        // browser is healthy, but the proxy claims the name first.
        browser: !proxy.on || bypassCovers(proxy.exceptions, d.host) ? 'direct' : 'shadowed',
        serviceState: d.service
          ? agent
            ? { running: !!agent.running, pid: agent.pid, disabled: agent.disabled, lastExit: agent.lastExit }
            : { missing: true }
          : null,
      };
    })
  );
  return {
    ingress: { up: ingressUp, aliasIp: ALIAS_IP, aliasIp6: ALIAS_IP6 },
    autoApply,
    proxy,
    dnsPending: pending,
    applyDnsCommand: sudoCommand('apply-dns.sh'),
    installCommand: sudoCommand('install.sh'),
    agents: jobs.filter((j) => j.owned && !j.disabled).map((j) => j.label).sort(),
    domains,
  };
}

// ---------------------------------------------------------- proxy reach ----
// The last hop between a correctly served domain and a working browser. When
// a system proxy is on, macOS hands the hostname to it BEFORE the hosts file
// or any resolver is consulted, so a name that exists only on this machine
// dies at the proxy (Chrome reports ERR_SOCKS_CONNECTION_FAILED). The bypass
// list is the exemption, and it is keyed by suffix — the same unit as the
// vanity-TLD registry — so one entry covers every site under a TLD, now and
// later. See server/proxy-lib.mjs for why this needs no root.

const registeredTlds = () => [
  ...BUILTIN_TLDS,
  ...readTlds().tlds.map((t) => String(t).toLowerCase()).filter((t) => !BUILTIN_TLDS.includes(t)),
];
const requiredBypass = () => registeredTlds().map(suffixEntry);

// The staged fallback for a machine whose account cannot write proxy settings
// directly. One op per network service, superseded by target like every other
// queued edit.
const PROXY_EDIT_KINDS = new Set(['proxy-bypass-set']);

async function proxyState() {
  const system = await readProxyState();
  const required = requiredBypass();
  // Coverage is judged against the EFFECTIVE exception list, because that is
  // the one the browser reads. A per-service list can be correct while the
  // active service's is not.
  const suffixes = registeredTlds().map((tld) => ({
    tld,
    entry: suffixEntry(tld),
    covered: bypassCovers(system.exceptions, `dockmaster-probe.${tld}`),
  }));
  const staged = readEdits().filter((e) => PROXY_EDIT_KINDS.has(e.kind));
  const writable = system.services.filter((service) => service.readable);
  const pendingByService = writable
    .map((service) => ({ service, plan: desiredBypass(service.bypass, required) }))
    .filter(({ plan }) => plan.changed);
  return {
    on: system.on,
    socks: system.socks,
    http: system.http,
    https: system.https,
    pac: system.pac,
    pacUrl: system.pacUrl,
    server: system.socksServer ? `${system.socksServer}:${system.socksPort || '?'}` : null,
    exceptions: system.exceptions,
    suffixes,
    // Only a live proxy can actually shadow a name; with every proxy off the
    // gaps are real but harmless, and saying otherwise would be a false alarm.
    gaps: system.on ? suffixes.filter((s) => !s.covered).map((s) => s.entry) : [],
    services: system.services.map((service) => ({
      name: service.name,
      enabled: service.enabled,
      readable: service.readable,
      bypass: service.bypass,
      missing: service.readable ? desiredBypass(service.bypass, required).added : [],
    })),
    pendingServices: pendingByService.map(({ service }) => service.name),
    staged,
    applyCommand: APPLY_EDITS_COMMAND,
  };
}

// ------------------------------------------------------------------ app ----

const app = express();
app.use('/api/ai', express.json({ limit: '4mb' }));
app.use(express.json());

app.get('/ai-chat-config.js', (_req, res) => {
  const config = aiChatClientConfig(aiRelays);
  res.type('application/javascript').set('Cache-Control', 'no-store');
  res.send(`window.AI_CHAT_CONFIG = ${JSON.stringify(config)};`);
});

app.post('/api/ai/v1/bridges/:provider/chat/completions', async (req, res) => {
  const entry = aiRelays.get(req.params.provider);
  if (!entry) return res.status(404).json({ error: { message: 'Unknown or unconfigured AI bridge.' } });
  const controller = new AbortController();
  req.once('aborted', () => controller.abort());
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const response = await entry.relay({ body: req.body, signal: controller.signal });
    res.status(response.status).set(response.headers);
    if (typeof response.body === 'string') {
      res.send(response.body);
    } else {
      res.flushHeaders();
      Readable.fromWeb(response.body)
        .on('error', (error) => res.destroy(error))
        .pipe(res);
    }
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 502;
    const message = status < 500 && error instanceof Error ? error.message : 'AI bridge request failed.';
    res.status(status).set('Cache-Control', 'no-store').json({ error: { message } });
  }
});

app.get('/api/ingress', async (_req, res) => res.json(await ingressState()));
app.get('/api/proxy', async (_req, res) => res.json(await proxyState()));

// Add every registered suffix to every network service's bypass list. The
// write is read back before it is reported as done; a service that refuses is
// staged for the privileged worker instead of being silently skipped.
app.post('/api/proxy/bypass', async (_req, res) => {
  const system = await readProxyState();
  const required = requiredBypass();
  const applied = [];
  const stagedNow = [];
  const failed = [];
  for (const service of system.services) {
    if (!service.readable) continue;
    const plan = desiredBypass(service.bypass, required);
    if (!plan.changed) continue;
    const wrote = await writeBypass(service.name, plan.list);
    if (wrote.ok) {
      applied.push({ service: service.name, added: plan.added });
      continue;
    }
    queueEdit({ id: randomUUID(), kind: 'proxy-bypass-set', service: service.name, domains: plan.list });
    stagedNow.push(service.name);
    failed.push(`${service.name}: ${wrote.error}`);
  }
  res.json({
    ok: failed.length === 0,
    applied,
    staged: stagedNow,
    errors: failed,
    applyCommand: APPLY_EDITS_COMMAND,
    // Chrome caches a failed proxy verdict per tab, so a fixed bypass still
    // needs a reload to be believed.
    hint: applied.length ? 'Reload the browser tab to pick up the new bypass.' : null,
  });
});
app.get('/api/activity', (_req, res) => res.json(autoApplyActivity()));
// Compatibility for clients from before Activity became its own page.
app.get('/api/ingress/activity', (_req, res) => res.json(autoApplyActivity()));
app.get('/api/docker/services', async (_req, res) => res.json(await discoverDockerWebServices()));
const remoteProviderError = (res, error) => {
  if (error instanceof RemoteProviderError && error.code === 'NOT_CONFIGURED') {
    return res.status(503).json({ error: 'The remote provider is not configured.' });
  }
  if (error instanceof RemoteProviderError && error.code === 'INVALID_REQUEST') {
    return res.status(400).json({ error: 'Remote provider request is invalid.' });
  }
  if (error instanceof RemoteProviderError && error.code === 'NOT_ALLOWLISTED') {
    return res.status(403).json({ error: 'Remote provider action is not allowlisted.' });
  }
  return res.status(502).json({ error: 'The dk-sin1 provider is unavailable.' });
};

app.get('/api/providers/dk-sin1/services', async (_req, res) => {
  try {
    res.json(await remoteProvider.request({ action: 'inventory' }));
  } catch (error) {
    remoteProviderError(res, error);
  }
});

app.get('/api/providers/dk-sin1/audit', async (_req, res) => {
  try {
    res.json(await remoteProvider.request({ action: 'audit' }));
  } catch (error) {
    remoteProviderError(res, error);
  }
});

app.post('/api/providers/dk-sin1/services/action', async (req, res) => {
  const { action, project, service } = req.body || {};
  try {
    res.json(await remoteProvider.request({ action, project, service }));
  } catch (error) {
    remoteProviderError(res, error);
  }
});

app.post('/api/ingress/domains', async (req, res) => {
  // The UI sends the bare NAME plus a TLD; the suffix is never typed on every
  // line (Daniel's nit). .test is the default; vanity TLDs must be registered
  // first. Full hosts are tolerated for the API.
  const tld = String(req.body?.tld ?? 'test').trim().toLowerCase().replace(/^\./, '');
  const validTlds = [...BUILTIN_TLDS, ...readTlds().tlds.map((t) => String(t).toLowerCase())];
  if (!validTlds.includes(tld)) {
    return res.status(400).json({ error: `.${tld} isn't a registered TLD — add it under Vanity TLDs first.` });
  }
  const name = String(req.body?.name ?? req.body?.host ?? '').trim().toLowerCase().replace(new RegExp(`\\.${tld}$`), '');
  const host = `${name}.${tld}`;
  const port = Number(req.body?.port);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return res.status(400).json({ error: `Name must be letters/digits/hyphens (the .${tld} suffix is automatic).` });
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
  refreshDnsPending();
  res.json({ ok: true, host });
});

// Edit = rename a domain, repoint it at a different upstream port, and/or
// link/unlink the launchd agent that backs it. A rename mints the replacement
// certificate before changing the registry, then stages cleanup of the old
// privileged DNS and hosts lines.
app.patch('/api/ingress/domains/:host', async (req, res) => {
  const host = String(req.params.host).toLowerCase();
  const reg = readRegistry();
  const entry = reg.domains.find((d) => d.host === host);
  if (!entry) return res.status(404).json({ error: 'Not registered.' });
  const wantsHost = req.body?.host !== undefined;
  const wantsPort = req.body?.port !== undefined;
  const wantsService = req.body?.service !== undefined;
  if (!wantsHost && !wantsPort && !wantsService) return res.status(400).json({ error: 'Nothing to change.' });

  let nextHost = host;
  if (wantsHost) {
    nextHost = String(req.body.host).trim().toLowerCase();
    const splitAt = nextHost.lastIndexOf('.');
    const name = nextHost.slice(0, splitAt);
    const tld = nextHost.slice(splitAt + 1);
    const validTlds = [...BUILTIN_TLDS, ...readTlds().tlds.map((item) => String(item).toLowerCase())];
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) || !validTlds.includes(tld)) {
      return res.status(400).json({ error: 'Domain must use a valid name and a registered TLD.' });
    }
    if (nextHost !== host && reg.domains.some((d) => d.host === nextHost)) {
      return res.status(409).json({ error: `${nextHost} is already registered.` });
    }
  }

  if (wantsPort) {
    const port = Number(req.body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: 'Upstream port must be 1–65535.' });
    }
    entry.port = port;
  }
  if (wantsService) {
    const service = String(req.body.service || '').trim();
    if (!service) {
      delete entry.service;
    } else {
      if (!OWNED.test(service)) {
        return res.status(400).json({ error: 'Only your own am.danielk./com.danielkam./dev.1dr0. agents can back a domain.' });
      }
      const job = (await listLaunchd()).find((j) => j.label === service && j.domain === 'user');
      if (!job) return res.status(404).json({ error: `No user agent labelled ${service}.` });
      entry.service = service;
    }
  }

  if (nextHost !== host) {
    const cert = path.join(CERTS, `${nextHost}.pem`);
    const key = path.join(CERTS, `${nextHost}-key.pem`);
    const mk = await run(MKCERT, ['-cert-file', cert, '-key-file', key, nextHost]);
    if (!mk.ok) {
      rmSync(cert, { force: true });
      rmSync(key, { force: true });
      return res.status(500).json({ error: `mkcert failed: ${mk.stderr.slice(0, 300)}` });
    }
    entry.host = nextHost;
    reg.domains.sort((a, b) => a.host.localeCompare(b.host));
  }

  writeRegistry(reg);
  if (wantsHost || wantsPort) regenerate();
  if (nextHost !== host) {
    for (const file of [`${host}.pem`, `${host}-key.pem`]) {
      rmSync(path.join(CERTS, file), { force: true });
    }
    queueEdit({ id: randomUUID(), kind: 'hosts-del', name: host });
    queueEdit({ id: randomUUID(), kind: 'dnsmasq-del', key: host });
    refreshDnsPending();
  }
  res.json({ ok: true, previousHost: host, host: nextHost, port: entry.port, service: entry.service ?? null });
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
  queueEdit({ id: randomUUID(), kind: 'hosts-del', name: host });
  queueEdit({ id: randomUUID(), kind: 'dnsmasq-del', key: host });
  refreshDnsPending();
  res.json({ ok: true });
});

// ------------------------------------------------- observed-domain edits ----
// The observed domains (hosts file, dnsmasq rules, resolver files) are
// root-owned, so the server never touches them. Edits enter a user-owned
// queue and are consumed by the root auto-apply job or a manual sudo run.

const EDITS_FILE = path.join(HOME, '.local/share/local-ingress/observed-edits.json');
const readEdits = () => { try { return JSON.parse(readFileSync(EDITS_FILE, 'utf8')); } catch { return []; } };
const writeEdits = (edits) => {
  const tmp = `${EDITS_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(edits, null, 2) + '\n');
    renameSync(tmp, EDITS_FILE);
  } finally {
    rmSync(tmp, { force: true });
  }
};
const APPLY_EDITS_COMMAND = sudoCommand('apply-edits.sh');

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const IP_RE = /^((\d{1,3}\.){3}\d{1,3}|[0-9a-f:]+)$/i;
const RESOLVER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// One staged op per target (last wins) — the queue is intent, not history.
const editTarget = (e) => e.kind.startsWith('hosts') ? `hosts:${e.name}` : e.kind.startsWith('dnsmasq') ? `dnsmasq:${e.key}` : e.kind.startsWith('proxy') ? `proxy:${e.service}` : `resolver:${e.file}`;
// Push an op onto the queue, superseding any op already targeting the same
// file/name/key. Shared by the observed-edit route and the vanity-TLD routes.
const queueEdit = (edit) => {
  const edits = readEdits().filter((e) => editTarget(e) !== editTarget(edit));
  edits.push(edit);
  writeEdits(edits);
  return edit;
};

app.get('/api/observed/edits', async (_req, res) => res.json({
  edits: readEdits(),
  applyCommand: APPLY_EDITS_COMMAND,
  autoApply: await autoApplyEnabled(),
}));

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
  queueEdit(edit);
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

// ------------------------------------------------------------ vanity TLDs ----
// A vanity TLD (.1dr0, .a8c, …) is a whole custom suffix routed to the local
// resolver, so any <name>.<tld> can then be registered as an ingress site just
// like a .test one. Registering a TLD needs exactly one privileged bit — the
// /etc/resolver/<tld> file — which is staged into the same queue as the
// observed-domain edits and applied by the one apply-edits.sh sudo run. The
// per-site cert, Caddy vhost, and dnsmasq/hosts lines are the existing ingress
// machinery, unchanged.
// Vanity TLDs may start with a digit (.1dr0 is the canonical example and its
// resolver file already works) — require alphanumeric ends, hyphens allowed
// inside, and at least one letter so an all-numeric label (which reads like an
// IP octet) is refused.
const TLD_RE = /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/;
const validTld = (tld) => TLD_RE.test(tld) && /[a-z]/.test(tld);
const resolverPath = (tld) => path.join(RESOLVER_DIR, tld);
const sitesUnder = (tld) => readRegistry().domains.filter((d) => d.host.endsWith(`.${tld}`)).map((d) => d.host);

async function tldsState() {
  ensureDirs();
  const custom = readTlds().tlds.map((t) => String(t).toLowerCase());
  const all = [...BUILTIN_TLDS, ...custom.filter((t) => !BUILTIN_TLDS.includes(t))];
  const edits = readEdits();
  const pending = (tld) => edits.some((e) => e.file === tld && (e.kind === 'resolver-write' || e.kind === 'resolver-del'));
  const tlds = all.map((tld) => {
    const hosts = sitesUnder(tld);
    return {
      tld,
      builtin: BUILTIN_TLDS.includes(tld),
      resolver: existsSync(resolverPath(tld)),
      resolverPending: pending(tld),
      sites: hosts.length,
      hosts,
    };
  });
  return {
    tlds,
    applyCommand: APPLY_EDITS_COMMAND,
    installCommand: sudoCommand('install.sh'),
    autoApply: await autoApplyEnabled(),
  };
}

app.get('/api/tlds', async (_req, res) => res.json(await tldsState()));

app.post('/api/tlds', (req, res) => {
  const tld = String(req.body?.tld ?? '').trim().toLowerCase().replace(/^\./, '');
  if (!validTld(tld)) {
    return res.status(400).json({ error: 'TLD must be letters, digits, and inner hyphens (no dots), start and end alphanumeric, and include at least one letter.' });
  }
  if (BUILTIN_TLDS.includes(tld)) {
    return res.status(409).json({ error: `.${tld} is the builtin default and is always available.` });
  }
  const reg = readTlds();
  if (reg.tlds.map((t) => String(t).toLowerCase()).includes(tld)) {
    return res.status(409).json({ error: `.${tld} is already registered.` });
  }
  reg.tlds.push(tld);
  reg.tlds.sort();
  writeTlds(reg);
  // Stage the resolver file only when it isn't already on disk (the .a8c /
  // .1dr0 files predate Dockmaster, so re-adding them needs no sudo).
  let staged = false;
  if (!existsSync(resolverPath(tld))) {
    queueEdit({ id: randomUUID(), kind: 'resolver-write', file: tld, content: resolverSeed() });
    staged = true;
  }
  res.json({ ok: true, tld, staged, applyCommand: APPLY_EDITS_COMMAND });
});

app.delete('/api/tlds/:tld', async (req, res) => {
  const tld = String(req.params.tld).toLowerCase().replace(/^\./, '');
  if (BUILTIN_TLDS.includes(tld)) return res.status(403).json({ error: `.${tld} is builtin and cannot be removed.` });
  const reg = readTlds();
  const list = reg.tlds.map((t) => String(t).toLowerCase());
  if (!list.includes(tld)) return res.status(404).json({ error: `.${tld} is not registered.` });
  const using = sitesUnder(tld);
  if (using.length) {
    return res.status(409).json({ error: `Remove its ${using.length} site${using.length > 1 ? 's' : ''} first: ${using.join(', ')}.` });
  }
  reg.tlds = list.filter((t) => t !== tld);
  writeTlds(reg);
  // Drop any still-pending resolver edit for this TLD first — otherwise an
  // add-then-remove before applying would leave an orphaned resolver-write
  // that still creates the file on the next sudo run.
  writeEdits(readEdits().filter((e) => !(e.file === tld && (e.kind === 'resolver-write' || e.kind === 'resolver-del'))));
  // Then stage removal of the resolver file, but only if it's actually on disk
  // (the dnsmasq wildcard, if any, goes inert once nothing routes the suffix).
  if (existsSync(resolverPath(tld))) queueEdit({ id: randomUUID(), kind: 'resolver-del', file: tld });
  // Retire the suffix's proxy exemption too, so the bypass list does not
  // accrete a line per experiment. Removal narrows the exemption, which is
  // the safe direction, and it targets this one exact entry — a neighbouring
  // entry someone else added is never touched. Best effort: a leftover entry
  // for a suffix nothing resolves is inert, so this must not fail the delete.
  const entry = suffixEntry(tld);
  const proxyCleanup = [];
  for (const service of (await readProxyState()).services) {
    if (!service.readable) continue;
    const plan = removeEntries(service.bypass, [entry]);
    if (!plan.changed) continue;
    if ((await writeBypass(service.name, plan.list)).ok) proxyCleanup.push(service.name);
  }
  res.json({ ok: true, tld, proxyCleanup, applyCommand: APPLY_EDITS_COMMAND });
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

// ---------------------------------------------------- service lifecycle ----
// Start/stop load and unload a user agent in the gui domain; enable/disable
// park the plist under a .disabled suffix (the filename convention already
// used across ~/Library/LaunchAgents) so login skips it. Owned user agents
// only — system daemons stay sudo-in-a-terminal territory.

const lifecycleJob = async (label, res) => {
  if (!OWNED.test(label)) {
    res.status(403).json({ error: 'Only your own am.danielk./com.danielkam./dev.1dr0. agents can be managed.' });
    return null;
  }
  const job = (await listLaunchd()).find((j) => j.label === label && j.domain === 'user');
  if (!job) {
    res.status(404).json({ error: 'Not a user-domain agent (system daemons need sudo in a terminal).' });
    return null;
  }
  return job;
};

app.post('/api/launchd/:label/start', async (req, res) => {
  const job = await lifecycleJob(req.params.label, res);
  if (!job) return;
  if (job.disabled) return res.status(409).json({ error: 'Disabled — enable it first.' });
  // Bootstrap if launchd doesn't know the label yet; kickstart (no -k, so a
  // running instance is left alone) if it does.
  const loaded = (await run('launchctl', ['print', `gui/${UID}/${job.label}`])).ok;
  const r = loaded
    ? await run('launchctl', ['kickstart', `gui/${UID}/${job.label}`])
    : await run('launchctl', ['bootstrap', `gui/${UID}`, job.file]);
  if (!r.ok) return res.status(500).json({ error: (r.stderr || r.stdout || 'launchctl failed.').trim().slice(0, 300) });
  res.json({ ok: true });
});

app.post('/api/launchd/:label/stop', async (req, res) => {
  const job = await lifecycleJob(req.params.label, res);
  if (!job) return;
  const r = await run('launchctl', ['bootout', `gui/${UID}/${job.label}`]);
  // Booting out an already-unloaded job is a no-op, not a failure.
  if (!r.ok && !/no such process/i.test(r.stderr)) {
    return res.status(500).json({ error: (r.stderr || 'launchctl failed.').trim().slice(0, 300) });
  }
  res.json({ ok: true, note: 'Unloaded — RunAtLoad brings it back at next login unless you disable it.' });
});

app.post('/api/launchd/:label/disable', async (req, res) => {
  const job = await lifecycleJob(req.params.label, res);
  if (!job) return;
  if (job.disabled) return res.status(409).json({ error: 'Already disabled.' });
  if (!plistEditable(job)) return res.status(403).json({ error: 'Only user agents under ~/Library/LaunchAgents can be disabled here.' });
  await run('launchctl', ['bootout', `gui/${UID}/${job.label}`]); // best-effort
  const parked = `${job.file}.disabled`;
  await rename(job.file, parked);
  res.json({ ok: true, file: parked });
});

app.post('/api/launchd/:label/enable', async (req, res) => {
  const job = await lifecycleJob(req.params.label, res);
  if (!job) return;
  if (!job.disabled) return res.status(409).json({ error: 'Already enabled.' });
  if (!plistEditable(job)) return res.status(403).json({ error: 'Only user agents under ~/Library/LaunchAgents can be enabled here.' });
  const live = job.file.replace(/(\.plist)\.[A-Za-z0-9._-]+$/, '$1');
  if (existsSync(live)) return res.status(409).json({ error: `${path.basename(live)} already exists — resolve the duplicate first.` });
  await rename(job.file, live);
  const r = await run('launchctl', ['bootstrap', `gui/${UID}`, live]);
  res.json({ ok: true, started: r.ok, file: live });
});

app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));

app.listen(PORT, '127.0.0.1', () => console.log(`Dockmaster v${appVersion} on http://127.0.0.1:${PORT}`));
