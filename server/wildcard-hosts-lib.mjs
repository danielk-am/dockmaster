// Hosts lines for the names served under a wildcard ingress entry.
//
// A *.m4.mac wildcard already routes every Coolify domain under it: one
// mkcert cert, one Caddy site, one dnsmasq rule. Chrome's Secure DNS ignores
// the scoped resolver and dnsmasq, though, and honours only /etc/hosts, which
// has no wildcards, so each name still needs its own hosts line there. The
// names come from the Traefik router rules Coolify writes onto containers.
import fs from 'node:fs';
import path from 'node:path';
import { ALIAS_IP, STATE, wildcardBase } from './ingress-lib.mjs';

// The names this sync added (or adopted), so it only ever removes its own.
export const SYNCED_HOSTS = path.join(STATE, 'wildcard-hosts.json');

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ROUTER_RULE_RE = /^traefik\.http\.routers\.[^.]+\.rule$/;

// Host(`a`) and Traefik v2's list form Host(`a`, `b`). HostRegexp and
// HostSNI are not plain names.
export const hostsFromRule = (rule) => {
	const names = [];
	for (const [, args] of String(rule ?? '').matchAll(/\bHost\(([^)]*)\)/g)) {
		for (const [, name] of args.matchAll(/`([^`]+)`/g)) names.push(name.trim().toLowerCase());
	}
	return names;
};

// Exactly one label under the base, which is what Caddy's *.<base> matches.
const covered = (wildcards, name) => wildcards.some((wildcard) => {
	const base = wildcardBase(wildcard);
	return name.endsWith(`.${base}`) && LABEL_RE.test(name.slice(0, -(base.length + 1)));
});

export const routedHosts = (containers, wildcards) => {
	const names = new Set();
	for (const container of containers || []) {
		for (const [key, rule] of Object.entries(container?.Config?.Labels || {})) {
			if (!ROUTER_RULE_RE.test(key)) continue;
			for (const name of hostsFromRule(rule)) if (covered(wildcards, name)) names.add(name);
		}
	}
	return [...names].sort();
};

// Names the hosts file already maps to the ingress alias.
export const hostsFileNames = (text) => {
	const names = new Set();
	for (const raw of String(text || '').split('\n')) {
		const line = raw.replace(/#.*/, '').trim();
		if (!line) continue;
		const [ip, ...hosts] = line.split(/\s+/);
		if (ip === ALIAS_IP) for (const host of hosts) names.add(host.toLowerCase());
	}
	return names;
};

// Add every routed name the hosts file lacks, adopt the ones already there,
// and remove only names this sync managed that nothing routes any more, so a
// hand-made line is never touched.
export const planHostsSync = ({ wanted, present, managed }) => {
	const want = new Set(wanted);
	return {
		add: [...want].filter((name) => !present.has(name)).sort(),
		remove: [...new Set(managed)].filter((name) => !want.has(name) && present.has(name)).sort(),
		managed: [...want].sort(),
	};
};

export const readSyncedHosts = () => {
	try {
		const data = JSON.parse(fs.readFileSync(SYNCED_HOSTS, 'utf8'));
		return Array.isArray(data.names) ? data.names : [];
	} catch {
		return [];
	}
};

export const writeSyncedHosts = (names) => fs.writeFileSync(SYNCED_HOSTS, JSON.stringify({ names }, null, '\t') + '\n');
