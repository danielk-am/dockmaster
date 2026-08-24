// Shared registry + config generation for the Local Ingress (used by the UI
// server and deploy/seed.mjs). All paths are user-owned; the root Caddy
// daemon only READS them (--watch applies changes live).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ALIAS_IP = '127.0.49.49';
export const ALIAS_IP6 = 'fd49::4949';
export const STATE = path.join(os.homedir(), '.local/share/local-ingress');
export const SITES = path.join(STATE, 'sites');
export const CERTS = path.join(STATE, 'certs');
export const REGISTRY = path.join(STATE, 'domains.json');
export const TLDS = path.join(STATE, 'tlds.json');
export const CADDYFILE = path.join(STATE, 'Caddyfile');
export const DNS_PENDING = path.join(STATE, 'dns-pending.conf');
export const DNSMASQ_CONF = '/opt/homebrew/etc/dnsmasq.conf';
export const RESOLVER_DIR = '/etc/resolver';
export const MKCERT = '/opt/homebrew/bin/mkcert';

// .test is the reserved, RFC-6761 suffix — always available, never removable.
// Vanity TLDs (.1dr0, .a8c, …) are opt-in and live in the registry below.
export const BUILTIN_TLDS = ['test'];

export const ensureDirs = () => {
	for (const dir of [STATE, SITES, CERTS]) fs.mkdirSync(dir, { recursive: true });
};

// The vanity-TLD registry — the set of custom suffixes the ingress will accept
// beside .test. One flat list of bare labels; the resolver file and any per-
// site cert/vhost are derived, never stored here.
export const readTlds = () => {
	try {
		const t = JSON.parse(fs.readFileSync(TLDS, 'utf8'));
		return { tlds: Array.isArray(t.tlds) ? t.tlds : [] };
	} catch {
		return { tlds: [] };
	}
};

export const writeTlds = (t) => fs.writeFileSync(TLDS, JSON.stringify(t, null, '\t') + '\n');

// A new vanity TLD's /etc/resolver/<tld> file mirrors the proven .test one
// exactly (routes the whole suffix to the local resolver), so it behaves
// identically to the suffix that already works. Fall back to the known-good
// content if .test isn't on disk yet.
export const resolverSeed = () => {
	try {
		const c = fs.readFileSync(path.join(RESOLVER_DIR, 'test'), 'utf8');
		if (c.trim()) return c.endsWith('\n') ? c : c + '\n';
	} catch { /* fall through to the default */ }
	return 'nameserver 127.0.0.1\n';
};

export const readRegistry = () => {
	try {
		return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
	} catch {
		return { domains: [] };
	}
};

export const writeRegistry = (reg) => fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, '\t') + '\n');

// Extra routes send one path prefix on a domain to a DIFFERENT local port.
// Some apps are two services behind one origin: Coolify serves its UI on
// 8000 but its realtime websocket dials the same hostname, expecting the
// proxy to hand /app/* to soketi on 6001 and /terminal/ws to 6002. A single
// reverse_proxy sends those to the app, which answers with HTML, and the
// socket reports "unavailable" while every other check reads healthy.
//
// A path must start with / and stays a Caddy matcher token; ports are the
// same 1-65535 the upstream uses. Order matters, so the catch-all is emitted
// last and the registry's order is preserved.
export const ROUTE_PATH_RE = /^\/[A-Za-z0-9._~\-/*]{0,190}$/;

export const validRoute = (route) => (
	!!route
	&& typeof route === 'object'
	&& !Array.isArray(route)
	&& typeof route.path === 'string'
	&& ROUTE_PATH_RE.test(route.path)
	&& Number.isInteger(Number(route.port))
	&& Number(route.port) >= 1
	&& Number(route.port) <= 65535
);

export const normalizeRoutes = (routes) => {
	if (!Array.isArray(routes)) return [];
	const seen = new Set();
	const out = [];
	for (const route of routes) {
		if (!validRoute(route)) continue;
		const path = route.path;
		if (seen.has(path)) continue;
		seen.add(path);
		out.push({ path, port: Number(route.port), ...(route.tls ? { tls: true } : {}) });
	}
	return out.slice(0, 20);
};

// An upstream that terminates TLS itself and routes by Host header must be
// dialled as https:// with verification off. The case here is a Coolify app
// behind the VM's own proxy: its certificate is minted by that proxy, not by
// mkcert, so it was never going to verify locally. Host must be forwarded
// explicitly: against an https:// upstream Caddy sends the upstream's own
// address as Host, and a Host-routing proxy answers 503 to that because no
// router matches 127.0.0.1:<port>. Verified against traefik:v3.7, which
// serves its default cert for any SNI but routes strictly on Host.
const proxyLine = (port, tls, depth) => {
	const pad = '\t'.repeat(depth);
	if (!tls) return `${pad}reverse_proxy 127.0.0.1:${port}`;
	return [
		`${pad}reverse_proxy https://127.0.0.1:${port} {`,
		`${pad}\ttransport http {`,
		`${pad}\t\ttls_insecure_skip_verify`,
		`${pad}\t}`,
		`${pad}\theader_up Host {host}`,
		`${pad}}`,
	].join('\n');
};

const upstreams = ({ port, routes, tls }) => {
	const extra = normalizeRoutes(routes);
	// Keep the single-upstream shape byte-identical for the domains that do
	// not need routing, so adding this feature rewrites nothing.
	if (!extra.length) return proxyLine(port, tls, 1);
	return [
		...extra.map((r) => `	handle ${r.path} {
${proxyLine(r.port, r.tls, 2)}
	}`),
		`	handle {
${proxyLine(port, tls, 2)}
	}`,
	].join('\n');
};

export const siteBlock = ({ host, port, routes, tls }) => `# Generated by local-ingress — do not hand-edit (the registry wins).
https://${host} {
	bind ${ALIAS_IP} ${ALIAS_IP6}
	tls ${CERTS}/${host}.pem ${CERTS}/${host}-key.pem
${upstreams({ port, routes, tls })}
}

http://${host} {
	bind ${ALIAS_IP} ${ALIAS_IP6}
	redir https://${host}{uri} 308
}
`;

export const dnsLines = (host) => [`address=/${host}/${ALIAS_IP}`, `address=/${host}/${ALIAS_IP6}`];

// /etc/hosts entries too: Chrome's Secure DNS (DoH) bypasses scoped
// resolvers AND dnsmasq — .test is guaranteed-NXDOMAIN at any public
// resolver — but every browser still consults the hosts file first.
export const HOSTS_FILE = '/etc/hosts';
export const HOSTS_PENDING = path.join(STATE, 'hosts-pending.conf');
export const hostsLines = (host) => [`${ALIAS_IP} ${host}`, `${ALIAS_IP6} ${host}`];

// launchd watches these files for auto-apply. Avoid rewriting identical
// content on every GET /api/ingress, which would wake the root helper even
// when there is nothing new to do. Rename keeps each update atomic if the
// helper claims the previous file at the same moment.
const writeIfChanged = (file, content) => {
	let current = null;
	try { current = fs.readFileSync(file, 'utf8'); } catch { /* create below */ }
	if (current === content) return;
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, content);
		fs.renameSync(tmp, file);
	} finally {
		try { fs.rmSync(tmp); } catch { /* renamed or never created */ }
	}
};

// Privileged residue (dnsmasq address= lines + /etc/hosts entries) is
// staged into pending files and consumed by auto-apply or apply-dns.sh.
// A line leaves its staging file once the target file already carries it.
export const refreshDnsPending = () => {
	const conf = fs.existsSync(DNSMASQ_CONF) ? fs.readFileSync(DNSMASQ_CONF, 'utf8') : '';
	const hosts = fs.existsSync(HOSTS_FILE) ? fs.readFileSync(HOSTS_FILE, 'utf8') : '';
	const reg = readRegistry();
	const pendingDns = reg.domains.flatMap((d) => dnsLines(d.host)).filter((line) => !conf.includes(line));
	const pendingHosts = reg.domains.flatMap((d) => hostsLines(d.host)).filter((line) => !hosts.includes(line));
	writeIfChanged(DNS_PENDING, pendingDns.length ? pendingDns.join('\n') + '\n' : '');
	writeIfChanged(HOSTS_PENDING, pendingHosts.length ? pendingHosts.join('\n') + '\n' : '');
	return [...pendingDns, ...pendingHosts];
};

// caddy --watch watches the MAIN config file; imported site files are
// re-read on reload, so bumping the generation comment triggers the reload.
export const regenerate = () => {
	ensureDirs();
	const reg = readRegistry();
	for (const f of fs.readdirSync(SITES)) {
		if (f.endsWith('.caddy')) fs.rmSync(path.join(SITES, f));
	}
	for (const d of reg.domains) {
		fs.writeFileSync(path.join(SITES, `${d.host}.caddy`), siteBlock(d));
	}
	fs.writeFileSync(
		CADDYFILE,
		`# Local Ingress root config (am.danielk.local-ingress runs this with --watch).\n# generation: ${Date.now()}\n{\n\tadmin off\n\tauto_https off\n}\n\nimport ${SITES}/*.caddy\n`
	);
	refreshDnsPending();
};
