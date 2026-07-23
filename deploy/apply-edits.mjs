// Dockmaster: root-side applier for staged observed-domain edits.
// Reads the user-owned queue, applies each op to the privileged files with
// backups, restarts dnsmasq / flushes caches only when touched, then clears
// the queue. Line surgery is done here in Node — not sed — so hostnames and
// keys are compared as tokens, never as regex fragments.
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const EDITS_FILE = '/Users/danielkam/.local/share/local-ingress/observed-edits.json';
const HOSTS = '/etc/hosts';
const MASQ = '/opt/homebrew/etc/dnsmasq.conf';
const RESOLVER_DIR = '/etc/resolver';
const RESOLVER_RE = /^[a-z0-9._-]+$/i;

let edits = [];
try { edits = JSON.parse(readFileSync(EDITS_FILE, 'utf8')); } catch { /* empty */ }
if (!Array.isArray(edits) || edits.length === 0) {
  console.log('No staged edits.');
  process.exit(0);
}

let hosts = readFileSync(HOSTS, 'utf8');
let hostsDirty = false;
let masq = existsSync(MASQ) ? readFileSync(MASQ, 'utf8') : null;
let masqDirty = false;

// Remove NAME from every hosts line it appears on as a hostname token;
// drop lines left with no hostnames.
const stripHost = (text, name) =>
  text
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*)([0-9a-fA-F:.]+)(\s+)(.*)$/);
      if (!m) return line;
      const rest = m[4].split(/(\s+)/);
      const kept = [];
      let dropped = false;
      for (const tok of rest) {
        if (/^\s+$/.test(tok) || tok === '') { kept.push(tok); continue; }
        if (tok.startsWith('#')) { kept.push(rest.slice(rest.indexOf(tok)).join('')); break; }
        if (tok.toLowerCase() === name) { dropped = true; continue; }
        kept.push(tok);
      }
      if (!dropped) return line;
      const remaining = kept.join('').trim();
      if (!remaining || remaining.startsWith('#')) return null;
      return `${m[1]}${m[2]}${m[3]}${remaining}`;
    })
    .filter((l) => l !== null)
    .join('\n');

for (const e of edits) {
  switch (e.kind) {
    case 'hosts-del': {
      hosts = stripHost(hosts, e.name);
      hostsDirty = true;
      console.log(`hosts: removed ${e.name}`);
      break;
    }
    case 'hosts-set': {
      hosts = stripHost(hosts, e.name);
      if (!hosts.endsWith('\n')) hosts += '\n';
      hosts += `${e.ip}\t${e.name}\n`;
      hostsDirty = true;
      console.log(`hosts: ${e.name} -> ${e.ip}`);
      break;
    }
    case 'dnsmasq-set': {
      if (masq === null) { console.log(`dnsmasq: conf missing, skipped ${e.key}`); break; }
      const prefix = `address=/${e.key}/`;
      let found = false;
      masq = masq
        .split('\n')
        .map((line) => (line.trim().startsWith(prefix) ? ((found = true), `address=/${e.key}/${e.ip}`) : line))
        .join('\n');
      if (!found) {
        if (!masq.endsWith('\n')) masq += '\n';
        masq += `address=/${e.key}/${e.ip}\n`;
      }
      masqDirty = true;
      console.log(`dnsmasq: /${e.key}/ -> ${e.ip}`);
      break;
    }
    case 'dnsmasq-del': {
      if (masq === null) { console.log(`dnsmasq: conf missing, skipped ${e.key}`); break; }
      const prefix = `address=/${e.key}/`;
      masq = masq.split('\n').filter((line) => !line.trim().startsWith(prefix)).join('\n');
      masqDirty = true;
      console.log(`dnsmasq: removed /${e.key}/`);
      break;
    }
    case 'resolver-write': {
      if (!RESOLVER_RE.test(e.file)) { console.log(`resolver: bad name, skipped`); break; }
      writeFileSync(path.join(RESOLVER_DIR, e.file), e.content);
      console.log(`resolver: wrote /etc/resolver/${e.file}`);
      break;
    }
    case 'resolver-del': {
      if (!RESOLVER_RE.test(e.file)) { console.log(`resolver: bad name, skipped`); break; }
      rmSync(path.join(RESOLVER_DIR, e.file), { force: true });
      console.log(`resolver: removed /etc/resolver/${e.file}`);
      break;
    }
    default:
      console.log(`unknown edit kind ${e.kind}, skipped`);
  }
}

if (hostsDirty) {
  copyFileSync(HOSTS, `${HOSTS}.dockmaster.bak`);
  writeFileSync(HOSTS, hosts);
}
if (masqDirty && masq !== null) {
  copyFileSync(MASQ, `${MASQ}.dockmaster.bak`);
  writeFileSync(MASQ, masq);
  // brew services restart as root silently no-ops — kickstart is the one
  // that actually restarts the system daemon.
  try { execSync('launchctl kickstart -k system/homebrew.mxcl.dnsmasq', { stdio: 'inherit' }); } catch { console.log('dnsmasq kickstart failed — restart it manually.'); }
}
try { execSync('dscacheutil -flushcache'); execSync('killall -HUP mDNSResponder'); } catch { /* cache flush is best-effort */ }

writeFileSync(EDITS_FILE, '[]\n');
console.log(`Applied ${edits.length} edit(s). Backups: ${hostsDirty ? HOSTS + '.dockmaster.bak ' : ''}${masqDirty ? MASQ + '.dockmaster.bak' : ''}`.trim());
