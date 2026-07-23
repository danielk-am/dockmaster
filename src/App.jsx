// Portside — the app shell (composing-app-shells: brand header, nav,
// version footer) around five read-mostly views of local dev infra.
import { useCallback, useEffect, useState } from 'react';
import { Button, Notice, Spinner, __experimentalText as Text } from '@wordpress/components';

const NAV = [
  { id: 'overview', label: 'Overview' },
  { id: 'ingress', label: 'Ingress' },
  { id: 'ports', label: 'Ports' },
  { id: 'domains', label: 'Domains' },
  { id: 'services', label: 'Services' },
  { id: 'dns', label: 'DNS chain' },
];

const get = (p) => fetch(`/api/${p}`).then((r) => r.json());

// The system | light | dark triad (the shared convention for our local
// apps): the preference persists per-app in localStorage, "system" resolves
// against prefers-color-scheme live, and the resolved theme is stamped as
// data-theme on <html> so the CSS only ever sees the two concrete themes.
// Light — the Snippet Manager's white approach — is the default.
const THEME_KEY = 'portside-theme';
const THEMES = ['system', 'light', 'dark'];

function useTheme() {
  const [pref, setPref] = useState(() => {
    const stored = localStorage.getItem(THEME_KEY);
    return THEMES.includes(stored) ? stored : 'light';
  });
  useEffect(() => {
    localStorage.setItem(THEME_KEY, pref);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);
  return [pref, setPref];
}

function ThemeSwitch({ pref, onChange }) {
  return (
    <div className="ps-themeswitch" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t} className={pref === t ? 'is-active' : ''} onClick={() => onChange(t)}>
          {t[0].toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
}

function useApi(path, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(() => {
    setError(null);
    get(path).then(setData).catch((e) => setError(String(e)));
  }, [path]);
  useEffect(reload, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload };
}

const Chip = ({ tone = 'neutral', children }) => <span className={`ps-chip ps-chip--${tone}`}>{children}</span>;

function Section({ title, actions, children }) {
  return (
    <section className="ps-section">
      <div className="ps-section__head">
        <h2>{title}</h2>
        <div className="ps-section__actions">{actions}</div>
      </div>
      {children}
    </section>
  );
}

function Overview({ go }) {
  const { data, error, reload } = useApi('overview');
  if (error) return <Notice status="error" isDismissible={false}>{error}</Notice>;
  if (!data) return <Spinner />;
  const { counts, dns } = data;
  const cards = [
    { id: 'ports', label: 'Listening ports', value: counts.ports, sub: counts.sharedPorts ? `${counts.sharedPorts} shared between processes` : 'no shared ports' },
    { id: 'domains', label: 'Local domains', value: counts.domains, sub: 'hosts, dnsmasq, resolver files' },
    { id: 'services', label: 'Launchd services', value: counts.services, sub: `${counts.running} running (user domain)` },
    { id: 'dns', label: 'DNS layers', value: (dns.nextdns ? 1 : 0) + (dns.dnsmasq ? 1 : 0) + 1, sub: [dns.nextdns && 'NextDNS', dns.dnsmasq && 'dnsmasq', 'system'].filter(Boolean).join(' → ') },
  ];
  return (
    <Section title="Overview" actions={<Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>}>
      {dns.nextdns && (
        <Notice status="warning" isDismissible={false}>
          NextDNS is running — it sits above the scoped resolvers, so local domains can resolve differently in browsers than dnsmasq intends. Check the Domains view for divergence flags.
        </Notice>
      )}
      <div className="ps-cards">
        {cards.map((c) => (
          <button key={c.id} className="ps-statcard" onClick={() => go(c.id)}>
            <span className="ps-statcard__value">{c.value}</span>
            <span className="ps-statcard__label">{c.label}</span>
            <span className="ps-statcard__sub">{c.sub}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

// The management half (absorbed from Local Ingress): the registry drives
// user-owned Caddy site blocks + mkcert certs; the root daemon's
// caddy --watch applies changes live, so add/remove needs no sudo — only
// new DNS/hosts lines stage for one privileged apply.
function Ingress() {
  const { data, error, reload } = useApi('ingress');
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmHost, setConfirmHost] = useState(null);
  if (error) return <Notice status="error" isDismissible={false}>{error}</Notice>;
  if (!data) return <Spinner />;
  const add = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch('/api/ingress/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, port: Number(port) }),
      }).then(async (x) => { const b = await x.json(); if (!x.ok) throw new Error(b.error); return b; });
      setNotice({ status: 'success', text: `${r.host} registered — live as soon as any staged DNS applies.` });
      setName('');
      setPort('');
      reload();
    } catch (e) {
      setNotice({ status: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (host) => {
    setConfirmHost(null);
    await fetch(`/api/ingress/domains/${encodeURIComponent(host)}`, { method: 'DELETE' });
    reload();
  };
  return (
    <Section
      title="Ingress"
      actions={<Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>}
    >
      <div className="ps-dnsrow">
        <Chip tone={data.ingress.up ? 'success' : 'error'}>
          {data.ingress.up ? 'ingress daemon up' : 'ingress daemon down'}
        </Chip>
        <Chip>{data.ingress.aliasIp} + {data.ingress.aliasIp6}</Chip>
      </div>
      {!data.ingress.up && (
        <Notice status="error" isDismissible={false}>
          The root ingress daemon isn’t serving — run <code className="ps-command" onClick={() => navigator.clipboard.writeText(data.installCommand)} title="Click to copy">{data.installCommand}</code>
        </Notice>
      )}
      {data.dnsPending.length > 0 && (
        <Notice status="warning" isDismissible={false}>
          {data.dnsPending.length} staged DNS/hosts line{data.dnsPending.length > 1 ? 's' : ''} need one privileged apply:{' '}
          <code className="ps-command" onClick={() => navigator.clipboard.writeText(data.applyDnsCommand)} title="Click to copy">{data.applyDnsCommand}</code>
        </Notice>
      )}
      {notice && <Notice status={notice.status} onRemove={() => setNotice(null)}>{notice.text}</Notice>}
      <div className="ps-addrow">
        <div className="ps-suffixfield">
          <input
            placeholder="myapp"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\.test$/, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter' && name && port) add(); }}
          />
          <span>.test</span>
        </div>
        <input
          className="ps-search ps-portinput"
          placeholder="port"
          inputMode="numeric"
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter' && name && port) add(); }}
        />
        <Button __next40pxDefaultSize variant="primary" isBusy={busy} disabled={!name || !port} onClick={add}>
          Add domain
        </Button>
      </div>
      <table className="ps-table">
        <thead><tr><th>Domain</th><th>Upstream</th><th>Cert</th><th>DNS</th><th>Status</th><th className="ps-right"></th></tr></thead>
        <tbody>
          {data.domains.map((d) => (
            <tr key={d.host}>
              <td className="ps-mono"><a href={d.url} target="_blank" rel="noreferrer">{d.host}</a></td>
              <td className="ps-mono">127.0.0.1:{d.port}</td>
              <td>{d.cert ? <Chip tone="success">minted</Chip> : <Chip tone="error">missing</Chip>}</td>
              <td>{d.dns === 'ok' ? <Chip tone="success">resolving</Chip> : <Chip tone="warning">pending apply</Chip>}</td>
              <td>{d.upstream === 'up' ? <Chip tone="success">upstream up</Chip> : <Chip tone="warning">upstream down</Chip>}</td>
              <td className="ps-right">
                <Button size="small" variant="tertiary" isDestructive onClick={() => setConfirmHost(d.host)}>Remove</Button>
              </td>
            </tr>
          ))}
          {!data.domains.length && (
            <tr><td colSpan={6} className="ps-emptycell">No domains yet — add one above; the daemon picks it up live.</td></tr>
          )}
        </tbody>
      </table>
      {confirmHost && (
        <Notice status="warning" onRemove={() => setConfirmHost(null)}>
          Remove {confirmHost} (site block + cert)?{' '}
          <Button size="small" variant="primary" isDestructive onClick={() => remove(confirmHost)}>Remove it</Button>
        </Notice>
      )}
      <Text className="ps-hint">Registered domains apply live (the root daemon watches the user-owned config) — only brand-new DNS/hosts lines wait for the one sudo apply above.</Text>
    </Section>
  );
}

function Ports() {
  const { data, error, reload } = useApi('ports');
  const [q, setQ] = useState('');
  if (error) return <Notice status="error" isDismissible={false}>{error}</Notice>;
  if (!data) return <Spinner />;
  const rows = data.filter((r) => !q || `${r.port} ${r.process || ''} ${r.address}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Section
      title="Listening ports"
      actions={
        <>
          <input className="ps-search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>
        </>
      }
    >
      <table className="ps-table">
        <thead><tr><th>Port</th><th>Address</th><th>Process</th><th>User</th><th>PID</th><th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="ps-mono">{r.port}</td>
              <td className="ps-mono">{r.address}</td>
              <td>{r.process || <em>unknown</em>}</td>
              <td>{r.user || '—'}</td>
              <td className="ps-mono">{r.pid || '—'}</td>
              <td>{r.shared && <Chip tone="warning">shared port</Chip>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Text className="ps-hint">A “shared port” means two processes hold the same port on different addresses (a wildcard bind beside a specific one) — fine when intended, a collision when not.</Text>
    </Section>
  );
}

function Domains() {
  const { data, error, reload } = useApi('domains');
  if (error) return <Notice status="error" isDismissible={false}>{error}</Notice>;
  if (!data) return <Spinner />;
  return (
    <Section title="Local domains" actions={<Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>}>
      <table className="ps-table">
        <thead><tr><th>Domain</th><th>Declared in</th><th>System resolves</th><th>dnsmasq says</th><th>Listeners</th><th></th></tr></thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.name}>
              <td className="ps-mono">{d.name}</td>
              <td>{d.sources.join(', ')}</td>
              <td className="ps-mono">{[d.system.a, d.system.aaaa].filter(Boolean).join(' / ') || '—'}</td>
              <td className="ps-mono">{d.dnsmasq || '—'}</td>
              <td className="ps-mono">{d.listeners.join(', ') || '—'}</td>
              <td>
                {d.divergent && <Chip tone="error">divergent</Chip>}
                {d.dead && <Chip tone="warning">no answer</Chip>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Text className="ps-hint">“Divergent” = the system resolver and dnsmasq disagree — something (NextDNS, secure DNS, stale cache) is answering above the layer you configured.</Text>
    </Section>
  );
}

function Services() {
  const { data, error, reload } = useApi('launchd');
  const [busy, setBusy] = useState(null);
  const [log, setLog] = useState(null);
  const [notice, setNotice] = useState(null);
  if (error) return <Notice status="error" isDismissible={false}>{error}</Notice>;
  if (!data) return <Spinner />;
  const owned = data.filter((j) => j.owned && !j.disabled);
  const kick = async (label) => {
    setBusy(label);
    const r = await fetch(`/api/launchd/${encodeURIComponent(label)}/kickstart`, { method: 'POST' }).then((x) => x.json());
    setNotice(r.ok ? { status: 'success', text: `${label} kickstarted.` } : { status: 'error', text: r.error || r.stderr || 'Failed.' });
    setBusy(null);
    reload();
  };
  const showLog = async (label) => {
    const r = await fetch(`/api/launchd/${encodeURIComponent(label)}/log`).then((x) => x.json());
    setLog(r.error ? { path: label, lines: [r.error] } : r);
  };
  return (
    <Section title="Launchd services (yours)" actions={<Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>}>
      {notice && <Notice status={notice.status} onRemove={() => setNotice(null)}>{notice.text}</Notice>}
      <table className="ps-table">
        <thead><tr><th>Label</th><th>Domain</th><th>State</th><th>Last exit</th><th className="ps-right">Actions</th></tr></thead>
        <tbody>
          {owned.map((j) => (
            <tr key={j.domain + j.label}>
              <td className="ps-mono">{j.label}</td>
              <td>{j.domain}</td>
              <td>
                {j.domain === 'system' ? <Chip>root — state needs sudo</Chip>
                  : j.running ? <Chip tone="success">running · pid {j.pid}</Chip>
                  : <Chip tone={j.keepAlive ? 'error' : 'neutral'}>{j.keepAlive ? 'not running (KeepAlive!)' : 'idle'}</Chip>}
              </td>
              <td className="ps-mono">{j.lastExit ?? '—'}</td>
              <td className="ps-right">
                {j.log && <Button size="small" variant="tertiary" onClick={() => showLog(j.label)}>Log</Button>}
                {j.domain === 'user' && (
                  <Button size="small" variant="secondary" isBusy={busy === j.label} onClick={() => kick(j.label)}>Kickstart</Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {log && (
        <div className="ps-log">
          <div className="ps-log__head">
            <span className="ps-mono">{log.path}</span>
            <Button size="small" variant="tertiary" onClick={() => setLog(null)}>Close</Button>
          </div>
          <pre>{log.lines.join('\n') || '(empty)'}</pre>
        </div>
      )}
    </Section>
  );
}

function Dns() {
  const { data, error, reload } = useApi('dns');
  if (error) return <Notice status="error" isDismissible={false}>{error}</Notice>;
  if (!data) return <Spinner />;
  return (
    <Section title="DNS chain" actions={<Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>}>
      <div className="ps-dnsrow">
        <Chip tone={data.nextdns ? 'warning' : 'neutral'}>{data.nextdns ? 'NextDNS running' : 'NextDNS not detected'}</Chip>
        <Chip tone={data.dnsmasq ? 'success' : 'error'}>{data.dnsmasq ? 'dnsmasq running' : 'dnsmasq down'}</Chip>
        <Chip>default upstream: {data.defaultNameservers.join(', ') || 'none'}</Chip>
      </div>
      <table className="ps-table">
        <thead><tr><th>Scoped domain</th><th>Nameserver</th><th>Flags</th></tr></thead>
        <tbody>
          {data.scoped.map((r) => (
            <tr key={r.id}>
              <td className="ps-mono">*.{r.domain}</td>
              <td className="ps-mono">{r.nameservers.join(', ') || '—'}</td>
              <td>{r.flags}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Text className="ps-hint">Order of authority in practice: browser secure-DNS (if on) → NextDNS (if running) → scoped resolvers above → default upstream. When a local name misbehaves, walk this list top-down.</Text>
    </Section>
  );
}

export default function App() {
  const [page, setPage] = useState('overview');
  const [themePref, setThemePref] = useTheme();
  const Page = { overview: Overview, ingress: Ingress, ports: Ports, domains: Domains, services: Services, dns: Dns }[page];
  return (
    <div className="ps-app">
      <aside className="ps-sidebar">
        <div className="ps-brand">
          <span className="ps-brand__mark">⚓</span>
          <div>
            <strong>Local Portside</strong>
            <span className="ps-brand__sub">local dev infrastructure</span>
          </div>
        </div>
        <nav className="ps-nav">
          {NAV.map((n) => (
            <button key={n.id} className={page === n.id ? 'is-active' : ''} onClick={() => setPage(n.id)}>{n.label}</button>
          ))}
        </nav>
        <div className="ps-sidebar__footer">
          <ThemeSwitch pref={themePref} onChange={setThemePref} />
          <span>Local Portside v1.2.0</span>
        </div>
      </aside>
      <main className="ps-main">
        <Page go={setPage} />
      </main>
    </div>
  );
}
