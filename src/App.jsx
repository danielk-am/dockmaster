// Portside — the app shell (composing-app-shells: brand header, nav,
// version footer) around five read-mostly views of local dev infra.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Notice, Spinner, __experimentalText as Text } from '@wordpress/components';
import { DataViews, filterSortAndPaginate } from '@wordpress/dataviews';

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
const THEME_KEY = 'harbormaster-theme';
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

// Privileged-step callout: says WHAT, then numbered steps with the command
// in a copyable code field — no prose-buried commands (Daniel's rule).
function SudoSteps({ intro, command }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="ps-sudosteps">
      <p className="ps-sudosteps__intro">{intro}</p>
      <ol>
        <li>Open Terminal</li>
        <li>Copy the command below</li>
        <li>Paste and run it (it will ask for your password)</li>
      </ol>
      <div className="ps-sudosteps__cmd">
        <code>{command}</code>
        <Button __next40pxDefaultSize variant="secondary" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</Button>
      </div>
    </div>
  );
}

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

// All tabular views are DataViews (sort/search/pagination for free — the
// house standard, same as the Snippet Manager) over the API snapshots.
function PSDataView({ data, fields, actions, itemKey, perPage = 50 }) {
  const [view, setView] = useState(() => ({ type: 'table', page: 1, perPage, search: '', fields: fields.map((f) => f.id) }));
  const { data: shown, paginationInfo } = useMemo(() => filterSortAndPaginate(data, view, fields), [data, view, fields]);
  return (
    <div className="ps-dataviews">
      <DataViews
        data={shown}
        fields={fields}
        view={view}
        onChangeView={setView}
        actions={actions}
        defaultLayouts={{ table: {} }}
        paginationInfo={paginationInfo}
        getItemId={(item) => String(item[itemKey])}
      />
    </div>
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
          <SudoSteps intro="The root ingress daemon isn’t serving — one privileged install brings it up." command={data.installCommand} />
        </Notice>
      )}
      {data.dnsPending.length > 0 && (
        <Notice status="warning" isDismissible={false}>
          <SudoSteps intro={`${data.dnsPending.length} staged DNS/hosts line${data.dnsPending.length > 1 ? 's' : ''} need one privileged apply.`} command={data.applyDnsCommand} />
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
      <PSDataView
        data={data.domains}
        fields={[
          { id: 'host', label: 'Domain', getValue: ({ item }) => item.host, render: ({ item }) => <a className="ps-mono" href={item.url} target="_blank" rel="noreferrer">{item.host}</a>, enableGlobalSearch: true },
          { id: 'port', label: 'Upstream', getValue: ({ item }) => item.port, render: ({ item }) => <span className="ps-mono">127.0.0.1:{item.port}</span> },
          { id: 'cert', label: 'Cert', getValue: ({ item }) => (item.cert ? 'minted' : 'missing'), render: ({ item }) => (item.cert ? <Chip tone="success">minted</Chip> : <Chip tone="error">missing</Chip>) },
          { id: 'dns', label: 'DNS', getValue: ({ item }) => item.dns, render: ({ item }) => (item.dns === 'ok' ? <Chip tone="success">resolving</Chip> : <Chip tone="warning">pending apply</Chip>) },
          { id: 'upstream', label: 'Status', getValue: ({ item }) => item.upstream, render: ({ item }) => (item.upstream === 'up' ? <Chip tone="success">upstream up</Chip> : <Chip tone="warning">upstream down</Chip>) },
        ]}
        actions={[{ id: 'remove', label: 'Remove', isDestructive: true, callback: ([item]) => setConfirmHost(item.host) }]}
        itemKey="host"
      />
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
  if (error) return <Notice status="error" isDismissible={false}>{error}</Notice>;
  if (!data) return <Spinner />;
  const rows = data.map((r, i) => ({ ...r, _k: `${r.port}-${r.address}-${i}` }));
  const fields = [
    { id: 'port', label: 'Port', getValue: ({ item }) => item.port, render: ({ item }) => <span className="ps-mono">{item.port}</span> },
    { id: 'address', label: 'Address', getValue: ({ item }) => item.address, render: ({ item }) => <span className="ps-mono">{item.address}</span>, enableGlobalSearch: true },
    { id: 'process', label: 'Process', getValue: ({ item }) => item.process || '', enableGlobalSearch: true },
    { id: 'user', label: 'User', getValue: ({ item }) => item.user || '—' },
    { id: 'pid', label: 'PID', getValue: ({ item }) => item.pid || 0, render: ({ item }) => <span className="ps-mono">{item.pid || '—'}</span> },
    { id: 'flags', label: '', enableSorting: false, render: ({ item }) => (item.shared ? <Chip tone="warning">shared port</Chip> : null) },
  ];
  const kill = async (item) => {
    if (!window.confirm(`SIGTERM ${item.process} (pid ${item.pid}) holding :${item.port}?`)) return;
    const r = await fetch('/api/ports/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: item.pid }) }).then((x) => x.json());
    if (r.error) window.alert(r.error);
    setTimeout(reload, 800);
  };
  const actions = [
    { id: 'kill', label: 'Stop process (SIGTERM)', isDestructive: true, callback: ([item]) => kill(item), isEligible: (item) => !!item.pid && item.user && item.user !== 'root' },
  ];
  return (
    <Section title="Listening ports" actions={<Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>}>
      <PSDataView data={rows} fields={fields} actions={actions} itemKey="_k" />
      <Text className="ps-hint">A "shared port" means two processes hold the same port on different addresses (a wildcard bind beside a specific one) — fine when intended, a collision when not.</Text>
    </Section>
  );
}

function Domains() {
  const { data, error, reload } = useApi('domains');
  if (error) return <Notice status="error" isDismissible={false}>{error}</Notice>;
  if (!data) return <Spinner />;
  const fields = [
    { id: 'name', label: 'Domain', getValue: ({ item }) => item.name, render: ({ item }) => <span className="ps-mono">{item.name}</span>, enableGlobalSearch: true },
    { id: 'sources', label: 'Declared in', getValue: ({ item }) => item.sources.join(', '), enableGlobalSearch: true },
    { id: 'system', label: 'System resolves', enableSorting: false, render: ({ item }) => <span className="ps-mono">{[item.system.a, item.system.aaaa].filter(Boolean).join(' / ') || '—'}</span> },
    { id: 'dnsmasq', label: 'dnsmasq says', getValue: ({ item }) => item.dnsmasq || '—', render: ({ item }) => <span className="ps-mono">{item.dnsmasq || '—'}</span> },
    { id: 'listeners', label: 'Listeners', enableSorting: false, render: ({ item }) => <span className="ps-mono">{item.listeners.join(', ') || '—'}</span> },
    { id: 'flags', label: '', enableSorting: false, render: ({ item }) => (
      <>
        {item.divergent && <Chip tone="error">divergent</Chip>}
        {item.dead && <Chip tone="warning">no answer</Chip>}
      </>
    ) },
  ];
  return (
    <Section title="Local domains" actions={<Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>}>
      <PSDataView data={data} fields={fields} itemKey="name" />
      <Text className="ps-hint">"Divergent" = the system resolver and dnsmasq disagree — something (NextDNS, secure DNS, stale cache) is answering above the layer you configured.</Text>
    </Section>
  );
}

function Services() {
  const { data, error, reload } = useApi('launchd');
  const [panel, setPanel] = useState(null); // { title, lines }
  const [notice, setNotice] = useState(null);
  if (error) return <Notice status="error" isDismissible={false}>{error}</Notice>;
  if (!data) return <Spinner />;
  const rows = data.filter((j) => j.owned && !j.disabled).map((j) => ({ ...j, _k: `${j.domain}:${j.label}` }));
  const showFile = async (label, kind) => {
    const r = await fetch(`/api/launchd/${encodeURIComponent(label)}/${kind}`).then((x) => x.json());
    setPanel(r.error ? { title: label, lines: [r.error] } : { title: r.path, lines: r.lines });
  };
  const kick = async (label) => {
    const r = await fetch(`/api/launchd/${encodeURIComponent(label)}/kickstart`, { method: 'POST' }).then((x) => x.json());
    setNotice(r.ok ? { status: 'success', text: `${label} kickstarted.` } : { status: 'error', text: r.error || r.stderr || 'Failed.' });
    reload();
  };
  const fields = [
    { id: 'label', label: 'Label', getValue: ({ item }) => item.label, render: ({ item }) => <span className="ps-mono">{item.label}</span>, enableGlobalSearch: true },
    { id: 'domain', label: 'Domain', getValue: ({ item }) => item.domain },
    { id: 'state', label: 'State', getValue: ({ item }) => (item.running ? 2 : item.keepAlive ? 0 : 1), render: ({ item }) => (
      item.domain === 'system' ? <Chip>root — state needs sudo</Chip>
        : item.running ? <Chip tone="success">running · pid {item.pid}</Chip>
        : <Chip tone={item.keepAlive ? 'error' : 'neutral'}>{item.keepAlive ? 'not running (KeepAlive!)' : 'idle'}</Chip>
    ) },
    { id: 'lastExit', label: 'Last exit', getValue: ({ item }) => item.lastExit ?? '', render: ({ item }) => <span className="ps-mono">{item.lastExit ?? '—'}</span> },
  ];
  const actions = [
    { id: 'log', label: 'Log', callback: ([item]) => showFile(item.label, 'log'), isEligible: (item) => !!item.log },
    { id: 'plist', label: 'View plist', callback: ([item]) => showFile(item.label, 'plist') },
    { id: 'kickstart', label: 'Kickstart', callback: ([item]) => kick(item.label), isEligible: (item) => item.domain === 'user' },
  ];
  return (
    <Section title="Launchd services (yours)" actions={<Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>}>
      {notice && <Notice status={notice.status} onRemove={() => setNotice(null)}>{notice.text}</Notice>}
      <PSDataView data={rows} fields={fields} actions={actions} itemKey="_k" />
      {panel && (
        <div className="ps-log">
          <div className="ps-log__head">
            <span className="ps-mono">{panel.title}</span>
            <Button size="small" variant="tertiary" onClick={() => setPanel(null)}>Close</Button>
          </div>
          <pre>{panel.lines.join('\n') || '(empty)'}</pre>
        </div>
      )}
    </Section>
  );
}

function Dns() {
  const { data, error, reload } = useApi('dns');
  if (error) return <Notice status="error" isDismissible={false}>{error}</Notice>;
  if (!data) return <Spinner />;
  const fields = [
    { id: 'domain', label: 'Scoped domain', getValue: ({ item }) => item.domain, render: ({ item }) => <span className="ps-mono">*.{item.domain}</span>, enableGlobalSearch: true },
    { id: 'ns', label: 'Nameserver', enableSorting: false, render: ({ item }) => <span className="ps-mono">{item.nameservers.join(', ') || '—'}</span> },
    { id: 'flags', label: 'Flags', getValue: ({ item }) => item.flags || '' },
  ];
  return (
    <Section title="DNS chain" actions={<Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>}>
      <div className="ps-dnsrow">
        <Chip tone={data.nextdns ? 'warning' : 'neutral'}>{data.nextdns ? 'NextDNS running' : 'NextDNS not detected'}</Chip>
        <Chip tone={data.dnsmasq ? 'success' : 'error'}>{data.dnsmasq ? 'dnsmasq running' : 'dnsmasq down'}</Chip>
        <Chip>default upstream: {data.defaultNameservers.join(', ') || 'none'}</Chip>
      </div>
      <PSDataView data={data.scoped} fields={fields} itemKey="id" />
      <Text className="ps-hint">Order of authority in practice: browser secure-DNS (if on) → NextDNS (if running) → scoped resolvers above → default upstream. When a local name misbehaves, walk this list top-down.</Text>
    </Section>
  );
}

// Every screen owns its permalink (house rule): /ingress, /ports, /domains,
// /services, /dns — the server SPA-falls-back all GETs to index.html.
function usePath() {
  const valid = NAV.map((n) => n.id);
  const fromLocation = () => {
    const slug = window.location.pathname.replace(/^\/+/, '') || 'overview';
    return valid.includes(slug) ? slug : 'overview';
  };
  const [page, setPageState] = useState(fromLocation);
  useEffect(() => {
    const onPop = () => setPageState(fromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setPage = (id) => {
    window.history.pushState(null, '', id === 'overview' ? '/' : `/${id}`);
    setPageState(id);
  };
  return [page, setPage];
}

export default function App() {
  const [page, setPage] = usePath();
  const [themePref, setThemePref] = useTheme();
  const Page = { overview: Overview, ingress: Ingress, ports: Ports, domains: Domains, services: Services, dns: Dns }[page];
  return (
    <div className="ps-app">
      <aside className="ps-sidebar">
        <div className="ps-brand">
          <span className="ps-brand__mark">⚓</span>
          <div>
            <strong>Harbormaster</strong>
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
          <span>Harbormaster v2.0.0</span>
        </div>
      </aside>
      <main className="ps-main">
        <Page go={setPage} />
      </main>
    </div>
  );
}
