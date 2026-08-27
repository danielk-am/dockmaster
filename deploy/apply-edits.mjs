// Root-side applier for observed-domain edits. The auto-apply LaunchDaemon
// runs an installed, root-owned copy. Queue entries remain user-owned data
// and are validated again here before any privileged file is touched.
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import path from 'node:path';

const STATE = process.env.DOCKMASTER_AUTO_STATE_DIR || '/Users/danielkam/.local/share/local-ingress';
const EDITS_FILE = process.env.DOCKMASTER_AUTO_EDITS_FILE || path.join(STATE, 'observed-edits.json');
const HOSTS = process.env.DOCKMASTER_AUTO_HOSTS_FILE || '/etc/hosts';
const MASQ = process.env.DOCKMASTER_AUTO_DNSMASQ_CONF || '/opt/homebrew/etc/dnsmasq.conf';
const RESOLVER_DIR = process.env.DOCKMASTER_AUTO_RESOLVER_DIR || '/etc/resolver';
const TEST_MODE = process.env.DOCKMASTER_AUTO_TEST_MODE === '1';
const uid = process.getuid?.() ?? -1;

if (uid !== 0 && !TEST_MODE) {
  console.error('Run with sudo.');
  process.exit(1);
}
if (!existsSync(STATE)) {
  console.error(`State directory missing: ${STATE}`);
  process.exit(1);
}
const staleClaims = readdirSync(STATE)
  .filter((file) => /^observed-edits\.json\.applying\.[0-9]+$/.test(file))
  .map((file) => path.join(STATE, file))
  .filter((file) => {
    try {
      const item = lstatSync(file);
      return item.isFile() && !item.isSymbolicLink();
    } catch {
      return false;
    }
  })
  .sort();
const primaryMissingOrEmpty = !existsSync(EDITS_FILE) || statSync(EDITS_FILE).size === 0;
if (primaryMissingOrEmpty && staleClaims.length === 0) {
  console.log('No staged edits.');
  process.exit(0);
}
// The queue's resting state is "[]". Do not claim and recreate that file:
// doing so would modify a watched path and continuously wake launchd.
if (!primaryMissingOrEmpty && readFileSync(EDITS_FILE, 'utf8').trim() === '[]' && staleClaims.length === 0) {
  console.log('No staged edits.');
  process.exit(0);
}

// Claim one immutable queue generation. Localhost Manager may immediately create a
// replacement queue; that file is not cleared when this generation finishes.
const owner = statSync(STATE);
const recoveringStale = staleClaims.length > 0;
const claimed = recoveringStale ? staleClaims[0] : `${EDITS_FILE}.applying.${process.pid}`;
if (!recoveringStale) renameSync(EDITS_FILE, claimed);
if (!existsSync(EDITS_FILE)) {
  writeFileSync(EDITS_FILE, '[]\n', { mode: 0o644 });
  if (uid === 0) chownSync(EDITS_FILE, owner.uid, owner.gid);
  chmodSync(EDITS_FILE, 0o644);
}

const rejectClaim = (message) => {
  const rejected = `${EDITS_FILE}.rejected-${Date.now()}`;
  renameSync(claimed, rejected);
  console.error(`${message} Queue retained at ${rejected}`);
  process.exit(1);
};

let queued;
try {
  const raw = readFileSync(claimed, 'utf8');
  if (raw.length > 64 * 1024) rejectClaim('Edit queue exceeds 64 KiB.');
  queued = JSON.parse(raw);
} catch (error) {
  rejectClaim(`Invalid edit queue: ${error.message}`);
}
if (!Array.isArray(queued)) rejectClaim('Edit queue must be an array.');
if (queued.length > 100) rejectClaim('Edit queue exceeds 100 entries.');
if (queued.length === 0) {
  rmSync(claimed, { force: true });
  console.log('No staged edits.');
  process.exit(0);
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
const RESOLVER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const validIp = (value) => typeof value === 'string' && isIP(value) !== 0;
const validHostname = (value) => typeof value === 'string' && HOSTNAME_RE.test(value);
const validKey = (value) => (
  typeof value === 'string'
  && (value.startsWith('.') ? validHostname(value.slice(1)) : validHostname(value))
);

// A bypass entry is a hostname, a wildcard suffix, a bare address, or a CIDR
// block. Everything else is refused rather than handed to networksetup.
const BYPASS_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?:\/\d{1,3})?$/i;
// networksetup takes the service name as one argv element, so there is no
// shell to escape into; the bound is on shape and length only.
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9 ()._-]{0,62}$/;

const validate = (edit) => {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return null;
  const kind = edit.kind;
  if (kind === 'hosts-set' || kind === 'hosts-del') {
    if (!validHostname(edit.name)) return null;
    if (kind === 'hosts-set' && !validIp(edit.ip)) return null;
    return {
      kind,
      name: edit.name.toLowerCase(),
      ...(kind === 'hosts-set' ? { ip: edit.ip } : {}),
    };
  }
  if (kind === 'dnsmasq-set' || kind === 'dnsmasq-del') {
    if (!validKey(edit.key)) return null;
    if (kind === 'dnsmasq-set' && !validIp(edit.ip)) return null;
    return {
      kind,
      key: edit.key.toLowerCase(),
      ...(kind === 'dnsmasq-set' ? { ip: edit.ip } : {}),
    };
  }
  if (kind === 'proxy-bypass-set') {
    if (typeof edit.service !== 'string' || !SERVICE_RE.test(edit.service)) return null;
    if (!Array.isArray(edit.domains) || edit.domains.length > 100) return null;
    const domains = edit.domains.map((item) => String(item).trim().toLowerCase());
    if (domains.some((item) => !item || item.length > 253 || !BYPASS_RE.test(item))) return null;
    return { kind, service: edit.service, domains };
  }
  if (kind === 'resolver-write' || kind === 'resolver-del') {
    if (typeof edit.file !== 'string' || !RESOLVER_RE.test(edit.file)) return null;
    if (
      kind === 'resolver-write'
      && (
        typeof edit.content !== 'string'
        || !edit.content.trim()
        || edit.content.length > 4000
        || edit.content.includes('\0')
      )
    ) return null;
    return {
      kind,
      file: edit.file,
      ...(kind === 'resolver-write'
        ? { content: edit.content.endsWith('\n') ? edit.content : `${edit.content}\n` }
        : {}),
    };
  }
  return null;
};

const edits = [];
let rejected = 0;
for (const candidate of queued) {
  const edit = validate(candidate);
  if (edit) edits.push(edit);
  else {
    rejected += 1;
    console.error(`Rejected invalid edit: ${JSON.stringify(candidate).slice(0, 300)}`);
  }
}

// Remove NAME from every hosts line it appears on as a hostname token.
// Lines left with only an address are dropped.
const stripHost = (text, name) =>
  text
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*)([0-9a-fA-F:.]+)\s+(.*)$/);
      if (!match) return line;
      const hashAt = match[3].indexOf('#');
      const namesText = hashAt === -1 ? match[3] : match[3].slice(0, hashAt);
      const comment = hashAt === -1 ? '' : match[3].slice(hashAt).trim();
      const names = namesText.trim().split(/\s+/).filter(Boolean);
      const kept = names.filter((item) => item.toLowerCase() !== name);
      if (kept.length === names.length) return line;
      if (kept.length === 0) return null;
      return `${match[1]}${match[2]}\t${kept.join(' ')}${comment ? ` ${comment}` : ''}`;
    })
    .filter((line) => line !== null)
    .join('\n');

try {
  let hosts = readFileSync(HOSTS, 'utf8');
  let hostsDirty = false;
  let masq = existsSync(MASQ) ? readFileSync(MASQ, 'utf8') : null;
  let masqDirty = false;
  let resolverDirty = false;

  for (const edit of edits) {
    switch (edit.kind) {
      case 'hosts-del': {
        const next = stripHost(hosts, edit.name);
        hostsDirty ||= next !== hosts;
        hosts = next;
        console.log(`hosts: removed ${edit.name}`);
        break;
      }
      case 'hosts-set': {
        hosts = stripHost(hosts, edit.name);
        if (!hosts.endsWith('\n')) hosts += '\n';
        hosts += `${edit.ip}\t${edit.name}\n`;
        hostsDirty = true;
        console.log(`hosts: ${edit.name} -> ${edit.ip}`);
        break;
      }
      case 'dnsmasq-set': {
        if (masq === null) {
          console.error(`dnsmasq config missing, skipped ${edit.key}`);
          break;
        }
        const prefix = `address=/${edit.key}/`;
        masq = masq.split('\n').filter((line) => !line.trim().startsWith(prefix)).join('\n');
        if (!masq.endsWith('\n')) masq += '\n';
        masq += `address=/${edit.key}/${edit.ip}\n`;
        masqDirty = true;
        console.log(`dnsmasq: /${edit.key}/ -> ${edit.ip}`);
        break;
      }
      case 'dnsmasq-del': {
        if (masq === null) {
          console.error(`dnsmasq config missing, skipped ${edit.key}`);
          break;
        }
        const prefix = `address=/${edit.key}/`;
        const next = masq.split('\n').filter((line) => !line.trim().startsWith(prefix)).join('\n');
        masqDirty ||= next !== masq;
        masq = next;
        console.log(`dnsmasq: removed /${edit.key}/`);
        break;
      }
      case 'proxy-bypass-set': {
        // networksetup replaces the whole list, so the queued entry already
        // carries the merged result the server computed and re-validated
        // above. "Empty" is networksetup's own word for clearing the list.
        if (TEST_MODE) {
          console.log(`proxy: ${edit.service} bypass -> ${edit.domains.join(', ') || 'Empty'}`);
          break;
        }
        try {
          execFileSync('/usr/sbin/networksetup', [
            '-setproxybypassdomains',
            edit.service,
            ...(edit.domains.length ? edit.domains : ['Empty']),
          ], { stdio: 'inherit' });
          console.log(`proxy: ${edit.service} bypass -> ${edit.domains.join(', ') || 'Empty'}`);
        } catch (error) {
          console.error(`proxy: ${edit.service} bypass failed: ${error.message}`);
        }
        break;
      }
      case 'resolver-write': {
        const target = path.join(RESOLVER_DIR, edit.file);
        if (existsSync(target)) copyFileSync(target, `${target}.dockmaster.bak`);
        writeFileSync(target, edit.content);
        resolverDirty = true;
        console.log(`resolver: wrote ${target}`);
        break;
      }
      case 'resolver-del': {
        const target = path.join(RESOLVER_DIR, edit.file);
        if (existsSync(target)) {
          copyFileSync(target, `${target}.dockmaster.bak`);
          rmSync(target);
          resolverDirty = true;
        }
        console.log(`resolver: removed ${target}`);
        break;
      }
      default:
        break;
    }
  }

  if (hostsDirty) {
    copyFileSync(HOSTS, `${HOSTS}.dockmaster.bak`);
    writeFileSync(HOSTS, hosts);
  }
  if (masqDirty && masq !== null) {
    copyFileSync(MASQ, `${MASQ}.dockmaster.bak`);
    writeFileSync(MASQ, masq);
  }

  if (!TEST_MODE && masqDirty) {
    try {
      execFileSync('/bin/launchctl', ['kickstart', '-k', 'system/homebrew.mxcl.dnsmasq'], { stdio: 'inherit' });
    } catch {
      console.error('dnsmasq kickstart failed; restart it manually.');
    }
  }
  if (!TEST_MODE && (hostsDirty || masqDirty || resolverDirty)) {
    try { execFileSync('/usr/bin/dscacheutil', ['-flushcache']); } catch { /* best effort */ }
    try { execFileSync('/usr/bin/killall', ['-HUP', 'mDNSResponder']); } catch { /* best effort */ }
  }

  rmSync(claimed, { force: true });
  console.log(`Applied ${edits.length} edit(s); rejected ${rejected}.${recoveringStale ? ' Recovered one stale queue claim.' : ''}`);
} catch (error) {
  const failed = `${EDITS_FILE}.failed-${Date.now()}`;
  try { renameSync(claimed, failed); } catch { /* preserve original error */ }
  console.error(`Apply failed: ${error.message}. Claimed queue retained at ${failed}`);
  process.exit(1);
}
