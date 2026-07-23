// Dockmaster — the app shell (composing-app-shells: brand header, nav,
// version footer) around the views + management of local dev infra.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Button, Notice, SnackbarList, Spinner, __experimentalText as Text } from '@wordpress/components';
import { DataViews, filterSortAndPaginate } from '@wordpress/dataviews';

const VERSION = '2.3.0';

const NAV = [
  { id: 'overview', label: 'Overview' },
  { id: 'ingress', label: 'Ingress & Domains' },
  { id: 'ports', label: 'Ports' },
  { id: 'services', label: 'Services' },
  { id: 'dns', label: 'DNS chain' },
];

const get = (p) => fetch(`/api/${p}`).then((r) => r.json());

// Transient feedback lives in one place (the Snippet Manager's idiom): any
// screen calls notify(), the app renders the snackbar stack, success clears
// itself after four seconds.
const NotifyContext = createContext(() => {});
const useNotify = () => useContext(NotifyContext);

// The system | light | dark triad (the shared convention for our local
// apps): the preference persists per-app in localStorage, "system" resolves
// against prefers-color-scheme live, and the resolved theme is stamped as
// data-theme on <html> so the CSS only ever sees the two concrete themes.
// Light — the Snippet Manager's white approach — is the default.
const THEME_KEY = 'dockmaster-theme';
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

// Copy-for-AI. Every row and every section can be lifted out as a prompt you
// can paste into a cold assistant chat: the frame (what this machine is and
// what the table holds), the data as plain text, then the question. The
// screen renders chips and colours; the prompt has to carry the same facts in
// words, so fields describe themselves for text via getValue — or aiValue
// where the sort key isn't readable (Services sorts state by number).
const AI_FRAME = [
  'You are helping me understand my local development machine (a Mac).',
  'I run a dashboard called Dockmaster over it: listening ports, the local domains this machine declares (in /etc/hosts, dnsmasq, and /etc/resolver files), a root Caddy ingress that serves *.test over HTTPS to local ports, launchd agents, and the DNS resolution chain.',
].join(' ');

const aiLabel = (field) => field.label || field.id.charAt(0).toUpperCase() + field.id.slice(1);
const aiValue = (field, item) => {
  const raw = field.aiValue ? field.aiValue(item) : field.getValue?.({ item });
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  return text || '—';
};
// One entry reads best as labelled lines; a whole table reads best as a
// markdown table (compact enough that a long ports list still pastes clean).
const aiEntry = (fields, item) => fields.map((f) => `${aiLabel(f)}: ${aiValue(f, item)}`).join('\n');
const aiTable = (fields, rows) => {
  const cell = (f, item) => aiValue(f, item).replace(/\n/g, ' ').replace(/\|/g, '\\|');
  return [
    `| ${fields.map(aiLabel).join(' | ')} |`,
    `| ${fields.map(() => '---').join(' | ')} |`,
    ...rows.map((item) => `| ${fields.map((f) => cell(f, item)).join(' | ')} |`),
  ].join('\n');
};
const aiPrompt = ({ subject, body, question }) => [AI_FRAME, subject, body, question].filter(Boolean).join('\n\n');

const AI_SECTION_QUESTION =
  'What is this section telling me about my machine? Explain what I am looking at, then call out anything stale, misconfigured, duplicated, or risky — and what you would clean up first. Ask me before assuming anything is disposable.';

// Takes either the finished text or a builder to await, so building the
// prompt and copying it share one error path.
function useCopyPrompt() {
  const notify = useNotify();
  return useCallback(async (source, what) => {
    try {
      await navigator.clipboard.writeText(typeof source === 'function' ? await source() : source);
      notify(`Copied ${what} as an AI prompt — paste it into any assistant.`);
    } catch (e) {
      notify(`Could not copy: ${e.message}`, 'error');
    }
  }, [notify]);
}

// build() runs at click time so the prompt always carries the data on screen
// right now, not whatever was there when the button rendered. The machine
// snapshot on Overview waits on six shell-backed endpoints — several seconds
// — so the button has to say it is working, or it reads as dead.
function CopyForAI({ build, what, label = 'Copy for AI' }) {
  const copyPrompt = useCopyPrompt();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      __next40pxDefaultSize
      variant="secondary"
      isBusy={busy}
      disabled={busy}
      accessibleWhenDisabled
      onClick={async () => {
        setBusy(true);
        try {
          await copyPrompt(build, what);
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

// Every notice goes through this wrapper — never <Notice> directly.
// Notice announces itself to screen readers by running renderToString over
// its children *during its own render*, and that serializer calls child
// components as plain functions: their hooks (Button's useInstanceId,
// SudoSteps' useState) then land on the Notice's own fiber. Hook order holds
// only while the children keep the same shape — cancel one staged edit and
// the count shifts, React reads the wrong hook slot, and the render throws
// (TypeError: undefined is not an object — reading 'length'), which unmounts
// the app. Handing Notice a plain string keeps the serializer out of the path.
function PSNotice({ children, spokenMessage, ...props }) {
  return (
    <Notice {...props} spokenMessage={spokenMessage ?? (typeof children === 'string' ? children : '')}>
      {children}
    </Notice>
  );
}

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
function PSDataView({ data, fields, actions = [], itemKey, perPage = 50, aiWhat, aiQuestion }) {
  const copyPrompt = useCopyPrompt();
  const [view, setView] = useState(() => ({ type: 'table', page: 1, perPage, search: '', fields: fields.map((f) => f.id) }));
  const { data: shown, paginationInfo } = useMemo(() => filterSortAndPaginate(data, view, fields), [data, view, fields]);
  // Every table ends its action menu the same way: lift this one row out as a
  // prompt. One place to add it means no table can quietly go without it.
  const rowActions = [
    ...actions,
    {
      id: 'copy-ai',
      label: 'Copy as AI prompt',
      callback: ([item]) => copyPrompt(
        aiPrompt({ subject: `Below is one entry from ${aiWhat}.`, body: aiEntry(fields, item), question: aiQuestion }),
        'this entry',
      ),
    },
  ];
  return (
    <div className="ps-dataviews">
      <DataViews
        data={shown}
        fields={fields}
        view={view}
        onChangeView={setView}
        actions={rowActions}
        defaultLayouts={{ table: {} }}
        paginationInfo={paginationInfo}
        getItemId={(item) => String(item[itemKey])}
      />
    </div>
  );
}

// Field definitions live at module scope: one description of each table, used
// both by the view that renders it and by the whole-machine snapshot on
// Overview. (Stable identities also stop the filter/sort memo re-running on
// every render.)
const DOMAIN_FIELDS = [
  { id: 'host', label: 'Domain', getValue: ({ item }) => item.host, render: ({ item }) => <a className="ps-mono" href={item.url} target="_blank" rel="noreferrer">{item.host}</a>, enableGlobalSearch: true },
  { id: 'port', label: 'Upstream', getValue: ({ item }) => item.port, aiValue: (item) => `127.0.0.1:${item.port}`, render: ({ item }) => <span className="ps-mono">127.0.0.1:{item.port}</span> },
  { id: 'cert', label: 'Cert', getValue: ({ item }) => (item.cert ? 'minted' : 'missing'), render: ({ item }) => (item.cert ? <Chip tone="success">minted</Chip> : <Chip tone="error">missing</Chip>) },
  { id: 'dns', label: 'DNS', getValue: ({ item }) => item.dns, aiValue: (item) => (item.dns === 'ok' ? 'resolving' : 'pending apply'), render: ({ item }) => (item.dns === 'ok' ? <Chip tone="success">resolving</Chip> : <Chip tone="warning">pending apply</Chip>) },
  { id: 'upstream', label: 'Status', getValue: ({ item }) => item.upstream, aiValue: (item) => (item.upstream === 'up' ? 'upstream up' : 'upstream down'), render: ({ item }) => (item.upstream === 'up' ? <Chip tone="success">upstream up</Chip> : <Chip tone="warning">upstream down</Chip>) },
];

const OBSERVED_FIELDS = [
  { id: 'name', label: 'Domain', getValue: ({ item }) => item.name, render: ({ item }) => <span className="ps-mono">{item.name}</span>, enableGlobalSearch: true },
  { id: 'sources', label: 'Declared in', getValue: ({ item }) => item.sources.join(', '), enableGlobalSearch: true },
  { id: 'system', label: 'System resolves', enableSorting: false, getValue: ({ item }) => [item.system.a, item.system.aaaa].filter(Boolean).join(' / ') || '—', render: ({ item }) => <span className="ps-mono">{[item.system.a, item.system.aaaa].filter(Boolean).join(' / ') || '—'}</span> },
  { id: 'dnsmasq', label: 'dnsmasq says', getValue: ({ item }) => item.dnsmasq || '—', render: ({ item }) => <span className="ps-mono">{item.dnsmasq || '—'}</span> },
  { id: 'listeners', label: 'Listeners', enableSorting: false, getValue: ({ item }) => item.listeners.join(', '), render: ({ item }) => (
    item.listeners.length
      ? <span className="ps-listeners">{item.listeners.map((l) => <span key={l} className="ps-chip ps-chip--mono">{l}</span>)}</span>
      : <span className="ps-mono">—</span>
  ) },
  { id: 'flags', label: 'Flags', enableSorting: false, getValue: ({ item }) => [item.divergent && 'divergent', item.dead && 'no answer'].filter(Boolean).join(', '), render: ({ item }) => (
    <>
      {item.divergent && <Chip tone="error">divergent</Chip>}
      {item.dead && <Chip tone="warning">no answer</Chip>}
    </>
  ) },
];

const PORT_FIELDS = [
  { id: 'port', label: 'Port', getValue: ({ item }) => item.port, render: ({ item }) => <span className="ps-mono">{item.port}</span> },
  { id: 'address', label: 'Address', getValue: ({ item }) => item.address, render: ({ item }) => <span className="ps-mono">{item.address}</span>, enableGlobalSearch: true },
  { id: 'process', label: 'Process', getValue: ({ item }) => item.process || '', enableGlobalSearch: true },
  { id: 'user', label: 'User', getValue: ({ item }) => item.user || '—' },
  { id: 'pid', label: 'PID', getValue: ({ item }) => item.pid || 0, render: ({ item }) => <span className="ps-mono">{item.pid || '—'}</span> },
  { id: 'flags', label: 'Flags', enableSorting: false, getValue: ({ item }) => (item.shared ? 'shared port' : ''), render: ({ item }) => (item.shared ? <Chip tone="warning">shared port</Chip> : null) },
];

const SERVICE_FIELDS = [
  { id: 'label', label: 'Label', getValue: ({ item }) => item.label, render: ({ item }) => <span className="ps-mono">{item.label}</span>, enableGlobalSearch: true },
  { id: 'domain', label: 'Domain', getValue: ({ item }) => item.domain },
  {
    id: 'state',
    label: 'State',
    getValue: ({ item }) => (item.running ? 2 : item.keepAlive ? 0 : 1),
    aiValue: (item) => (
      item.domain === 'system' ? 'root — state needs sudo'
        : item.running ? `running (pid ${item.pid})`
        : item.keepAlive ? 'not running, but KeepAlive is set'
        : 'idle'
    ),
    render: ({ item }) => (
      item.domain === 'system' ? <Chip>root — state needs sudo</Chip>
        : item.running ? <Chip tone="success">running · pid {item.pid}</Chip>
        : <Chip tone={item.keepAlive ? 'error' : 'neutral'}>{item.keepAlive ? 'not running (KeepAlive!)' : 'idle'}</Chip>
    ),
  },
  { id: 'lastExit', label: 'Last exit', getValue: ({ item }) => item.lastExit ?? '', render: ({ item }) => <span className="ps-mono">{item.lastExit ?? '—'}</span> },
];

const DNS_FIELDS = [
  { id: 'domain', label: 'Scoped domain', getValue: ({ item }) => item.domain, aiValue: (item) => `*.${item.domain}`, render: ({ item }) => <span className="ps-mono">*.{item.domain}</span>, enableGlobalSearch: true },
  { id: 'ns', label: 'Nameserver', enableSorting: false, getValue: ({ item }) => item.nameservers.join(', ') || '—', render: ({ item }) => <span className="ps-mono">{item.nameservers.join(', ') || '—'}</span> },
  { id: 'flags', label: 'Flags', getValue: ({ item }) => item.flags || '' },
];

// What each table holds, in the words the prompt uses — shared by the row
// action and the section button so both frame the data the same way.
const AI_WHAT = {
  domains: 'the *.test domains registered with my local ingress (each one is a user-owned Caddy site block with an mkcert certificate, reverse-proxying HTTPS to a port on 127.0.0.1)',
  observed: 'the full list of local domain names this machine declares anywhere — /etc/hosts, dnsmasq rules, and /etc/resolver files — alongside what the system resolver and dnsmasq each answer, and which processes are listening on the address it resolves to',
  ports: 'the TCP ports currently being listened on by this machine',
  services: 'the launchd agents I own on this machine (loaded, not disabled)',
  dns: 'the scoped DNS resolvers configured in /etc/resolver, which send matching domains to a specific nameserver instead of the default upstream',
};

const AI_ROW_QUESTION = {
  domains: 'What is this domain about — what is likely running on that upstream port, and does anything here look wrong (missing certificate, DNS not resolving yet, upstream down)?',
  observed: 'What is this entry about — what most likely created it, what would still depend on it, and would it be safe to remove? Flag it if the entry looks stale, or if the system resolver and dnsmasq disagree.',
  ports: 'What is this process, and why would it be listening on this port? Tell me whether it is something a developer typically installs deliberately, what would break if I stopped it, and whether the port or bind address is a problem.',
  services: 'What does this launchd agent most likely do, what would break if I unloaded it, and does its state look healthy? A non-zero last exit code or a KeepAlive job that is not running means something is wrong — say so.',
  dns: 'What does this scoped resolver do, and is this a sensible configuration for local development? Tell me what would stop working if I removed it.',
};

// Overview's copy button takes the whole machine, not just the four numbers
// on screen — it pulls every view so one paste gives the assistant the ports,
// the domains, the agents and the DNS chain together.
async function machineSnapshot() {
  const [overview, ingress, observed, ports, services, dns] = await Promise.all([
    get('overview'), get('ingress'), get('domains'), get('ports'), get('launchd'), get('dns'),
  ]);
  const mine = services.filter((j) => j.owned && !j.disabled);
  return aiPrompt({
    subject: 'Below is a full snapshot of the machine, taken from every view in Dockmaster.',
    body: [
      '## Summary',
      `Listening ports: ${overview.counts.ports}${overview.counts.sharedPorts ? ` (${overview.counts.sharedPorts} shared between processes)` : ''}`,
      `Local domains declared: ${overview.counts.domains}`,
      `Launchd agents I own and have loaded: ${mine.length}, ${mine.filter((j) => j.running).length} running (the machine has ${overview.counts.services} launchd jobs in total, counting system and disabled ones)`,
      `DNS chain: ${[dns.nextdns && 'NextDNS', dns.dnsmasq && 'dnsmasq', 'system'].filter(Boolean).join(' → ')}`,
      `Ingress daemon: ${ingress.ingress.up ? `up on ${ingress.ingress.aliasIp} + ${ingress.ingress.aliasIp6}` : 'DOWN'}`,
      '',
      `## Registered *.test domains (${ingress.domains.length})`,
      aiTable(DOMAIN_FIELDS, ingress.domains),
      '',
      `## All observed local domains (${observed.length})`,
      aiTable(OBSERVED_FIELDS, observed),
      '',
      `## Listening ports (${ports.length})`,
      aiTable(PORT_FIELDS, ports),
      '',
      `## Launchd agents I own (${mine.length})`,
      aiTable(SERVICE_FIELDS, mine),
      '',
      `## Scoped DNS resolvers (${dns.scoped.length})`,
      `Default upstream: ${dns.defaultNameservers.join(', ') || 'none'}`,
      aiTable(DNS_FIELDS, dns.scoped),
    ].join('\n'),
    question: 'Give me a read on this machine: what is running, how the local domains resolve, and what you would fix or clean up first. Call out anything that looks stale, duplicated, or misconfigured — and ask me before assuming anything is disposable.',
  });
}

function Overview({ go }) {
  const { data, error, reload } = useApi('overview');
  if (error) return <PSNotice status="error" isDismissible={false}>{error}</PSNotice>;
  if (!data) return <Spinner />;
  const { counts, dns } = data;
  const cards = [
    { id: 'ports', label: 'Listening ports', value: counts.ports, sub: counts.sharedPorts ? `${counts.sharedPorts} shared between processes` : 'no shared ports' },
    { id: 'ingress', label: 'Local domains', value: counts.domains, sub: 'hosts, dnsmasq, resolver files' },
    { id: 'services', label: 'Launchd services', value: counts.services, sub: `${counts.running} running (user domain)` },
    { id: 'dns', label: 'DNS layers', value: (dns.nextdns ? 1 : 0) + (dns.dnsmasq ? 1 : 0) + 1, sub: [dns.nextdns && 'NextDNS', dns.dnsmasq && 'dnsmasq', 'system'].filter(Boolean).join(' → ') },
  ];
  return (
    <Section
      title="Overview"
      actions={
        <>
          <CopyForAI build={machineSnapshot} what="the whole machine (ports, domains, agents, DNS)" label="Copy machine for AI" />
          <Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>
        </>
      }
    >
      {dns.nextdns && (
        <PSNotice status="warning" isDismissible={false}>
          NextDNS is running — it sits above the scoped resolvers, so local domains can resolve differently in browsers than dnsmasq intends. Check Ingress &amp; Domains for divergence flags.
        </PSNotice>
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
// caddy --watch applies changes live, so add/edit/remove needs no sudo —
// only new DNS/hosts lines stage for one privileged apply. The observed-
// domains diagnostics live here too: one screen views AND manages domains.
function Ingress() {
  const { data, error, reload } = useApi('ingress');
  const observed = useApi('domains');
  const staged = useApi('observed/edits');
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmHost, setConfirmHost] = useState(null);
  const [edit, setEdit] = useState(null); // { host, port }
  const [ipEdit, setIpEdit] = useState(null); // { kind, name, key?, ip }
  const [resEdit, setResEdit] = useState(null); // { file, content, busy }
  if (error) return <PSNotice status="error" isDismissible={false}>{error}</PSNotice>;
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
  const savePort = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/ingress/domains/${encodeURIComponent(edit.host)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: Number(edit.port) }),
      }).then(async (x) => { const b = await x.json(); if (!x.ok) throw new Error(b.error); return b; });
      setNotice({ status: 'success', text: `${r.host} now proxies 127.0.0.1:${r.port} — live immediately.` });
      setEdit(null);
      reload();
    } catch (e) {
      setNotice({ status: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const refreshAll = () => { reload(); observed.reload(); staged.reload(); };
  // Observed-domain management: the underlying files are root-owned, so an
  // edit is STAGED (user-owned queue) and applied by one sudo run — the
  // ingress doctrine, extended to hosts/dnsmasq/resolver.
  const stage = async (body) => {
    const r = await fetch('/api/observed/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.error) setNotice({ status: 'error', text: r.error });
    staged.reload();
  };
  const unstage = async (id) => {
    await fetch(`/api/observed/edits/${id}`, { method: 'DELETE' });
    staged.reload();
  };
  const openResolver = async (file) => {
    const r = await fetch(`/api/observed/resolver/${encodeURIComponent(file)}`).then((x) => x.json());
    setResEdit({ file, content: r.error ? '' : r.content });
  };
  const stagedEdits = staged.data?.edits || [];
  // Mirror the server's wildcard rendering so a staged op can be matched
  // back to its display row.
  const stagedTargets = new Set(stagedEdits.map((e) => {
    if (e.name) return e.name;
    if (e.key) return e.key.startsWith('.') ? `*${e.key}` : e.key.includes('.') ? e.key : `*.${e.key}`;
    return `*.${e.file}`;
  }));
  const describeEdit = (e) => ({
    'hosts-set': `hosts: ${e.name} → ${e.ip}`,
    'hosts-del': `hosts: remove ${e.name}`,
    'dnsmasq-set': `dnsmasq: /${e.key}/ → ${e.ip}`,
    'dnsmasq-del': `dnsmasq: remove /${e.key}/`,
    'resolver-write': `resolver: rewrite /etc/resolver/${e.file}`,
    'resolver-del': `resolver: remove /etc/resolver/${e.file}`,
  })[e.kind] || e.kind;
  const managedHosts = new Set(data.domains.map((d) => d.host));
  const editableHost = (item) => item.inHosts && !managedHosts.has(item.name) && !item.name.startsWith('*');
  // The screen's own flags column says more than the shared definition can:
  // it also knows which rows have an edit queued and which the registry owns.
  const observedFields = OBSERVED_FIELDS.map((f) => (f.id !== 'flags' ? f : {
    ...f,
    getValue: ({ item }) => [
      item.divergent && 'divergent',
      item.dead && 'no answer',
      stagedTargets.has(item.name) && 'edit staged',
      managedHosts.has(item.name) && 'managed by the ingress registry',
    ].filter(Boolean).join(', '),
    render: ({ item }) => (
      <>
        {item.divergent && <Chip tone="error">divergent</Chip>}
        {item.dead && <Chip tone="warning">no answer</Chip>}
        {stagedTargets.has(item.name) && <Chip tone="warning">edit staged</Chip>}
        {managedHosts.has(item.name) && <Chip tone="success">managed</Chip>}
      </>
    ),
  }));
  const ingressState = [
    `Ingress daemon: ${data.ingress.up ? 'up' : 'DOWN'}, serving on ${data.ingress.aliasIp} + ${data.ingress.aliasIp6}`,
    `Staged DNS/hosts lines waiting for a privileged apply: ${data.dnsPending.length}`,
    stagedEdits.length ? `Staged edits to privileged files: ${stagedEdits.map(describeEdit).join('; ')}` : 'Staged edits to privileged files: none',
  ].join('\n');
  const registeredBlock = () => aiPrompt({
    subject: `Below, from Dockmaster: ${AI_WHAT.domains}.`,
    body: `${ingressState}\n\n${aiTable(DOMAIN_FIELDS, data.domains)}`,
    question: AI_SECTION_QUESTION,
  });
  const observedBlock = () => aiPrompt({
    subject: `Below, from Dockmaster: ${AI_WHAT.observed}.`,
    body: `${ingressState}\n\n${aiTable(observedFields, observed.data || [])}`,
    question: AI_SECTION_QUESTION,
  });
  const wholeScreen = () => aiPrompt({
    subject: 'Below is the whole "Ingress & Domains" view from Dockmaster — the *.test domains I registered with my local ingress, followed by every local domain name this machine declares anywhere.',
    body: [
      ingressState,
      '',
      `## Registered *.test domains (${data.domains.length})`,
      aiTable(DOMAIN_FIELDS, data.domains),
      '',
      `## All observed local domains (${(observed.data || []).length})`,
      aiTable(observedFields, observed.data || []),
    ].join('\n'),
    question: AI_SECTION_QUESTION,
  });
  return (
    <Section
      title="Ingress & Domains"
      actions={
        <>
          <CopyForAI build={wholeScreen} what="this whole screen" label="Copy screen for AI" />
          <Button __next40pxDefaultSize variant="secondary" onClick={refreshAll}>Refresh</Button>
        </>
      }
    >
      <div className="ps-dnsrow">
        <Chip tone={data.ingress.up ? 'success' : 'error'}>
          {data.ingress.up ? 'ingress daemon up' : 'ingress daemon down'}
        </Chip>
        <Chip>{data.ingress.aliasIp} + {data.ingress.aliasIp6}</Chip>
      </div>
      {!data.ingress.up && (
        <PSNotice
          status="error"
          isDismissible={false}
          spokenMessage="The root ingress daemon isn’t serving — one privileged install brings it up."
        >
          <SudoSteps intro="The root ingress daemon isn’t serving — one privileged install brings it up." command={data.installCommand} />
        </PSNotice>
      )}
      {data.dnsPending.length > 0 && (
        <PSNotice
          status="warning"
          isDismissible={false}
          spokenMessage={`${data.dnsPending.length} staged DNS or hosts line${data.dnsPending.length > 1 ? 's' : ''} need one privileged apply.`}
        >
          <SudoSteps intro={`${data.dnsPending.length} staged DNS/hosts line${data.dnsPending.length > 1 ? 's' : ''} need one privileged apply.`} command={data.applyDnsCommand} />
        </PSNotice>
      )}
      {notice && <PSNotice status={notice.status} onRemove={() => setNotice(null)}>{notice.text}</PSNotice>}
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
      <div className="ps-subhead-row">
        <h3 className="ps-subhead ps-subhead--flush">Registered *.test domains</h3>
        <CopyForAI build={registeredBlock} what="the registered domains" />
      </div>
      <PSDataView
        data={data.domains}
        fields={DOMAIN_FIELDS}
        actions={[
          { id: 'edit', label: 'Change port', callback: ([item]) => setEdit({ host: item.host, port: String(item.port) }) },
          { id: 'remove', label: 'Remove', isDestructive: true, callback: ([item]) => setConfirmHost(item.host) },
        ]}
        itemKey="host"
        aiWhat={AI_WHAT.domains}
        aiQuestion={AI_ROW_QUESTION.domains}
      />
      {edit && (
        <div className="ps-addrow">
          <div className="ps-suffixfield">
            <input value={edit.host} disabled />
            <span>→ 127.0.0.1:</span>
          </div>
          <input
            className="ps-search ps-portinput"
            autoFocus
            inputMode="numeric"
            value={edit.port}
            onChange={(e) => setEdit({ ...edit, port: e.target.value.replace(/\D/g, '') })}
            onKeyDown={(e) => { if (e.key === 'Enter' && edit.port) savePort(); if (e.key === 'Escape') setEdit(null); }}
          />
          <Button __next40pxDefaultSize variant="primary" isBusy={busy} disabled={!edit.port} onClick={savePort}>Save port</Button>
          <Button __next40pxDefaultSize variant="tertiary" onClick={() => setEdit(null)}>Cancel</Button>
        </div>
      )}
      {confirmHost && (
        <PSNotice status="warning" onRemove={() => setConfirmHost(null)} spokenMessage={`Remove ${confirmHost} — site block and cert?`}>
          Remove {confirmHost} (site block + cert)?{' '}
          <Button size="small" variant="primary" isDestructive onClick={() => remove(confirmHost)}>Remove it</Button>
        </PSNotice>
      )}
      <Text className="ps-hint">Registered domains apply live (the root daemon watches the user-owned config) — only brand-new DNS/hosts lines wait for the one sudo apply above.</Text>

      <div className="ps-subhead-row">
        <h3 className="ps-subhead ps-subhead--flush">All observed local domains</h3>
        <CopyForAI build={observedBlock} what="every observed local domain" />
      </div>
      {stagedEdits.length > 0 && (
        <PSNotice
          status="warning"
          isDismissible={false}
          spokenMessage={`${stagedEdits.length} staged edit${stagedEdits.length > 1 ? 's' : ''} to privileged files — apply once with sudo.`}
        >
          <SudoSteps intro={`${stagedEdits.length} staged edit${stagedEdits.length > 1 ? 's' : ''} to privileged files (hosts / dnsmasq / resolver) — apply once with sudo.`} command={staged.data.applyCommand} />
          <ul className="ps-editlist">
            {stagedEdits.map((e) => (
              <li key={e.id}>
                <code>{describeEdit(e)}</code>
                <Button size="small" variant="tertiary" onClick={() => unstage(e.id)}>Cancel</Button>
              </li>
            ))}
          </ul>
        </PSNotice>
      )}
      {observed.error && <PSNotice status="error" isDismissible={false}>{observed.error}</PSNotice>}
      {!observed.data && !observed.error && <Spinner />}
      {observed.data && (
        <>
          <PSDataView
            data={observed.data}
            fields={observedFields}
            actions={[
              { id: 'hosts-ip', label: 'Change hosts IP', isEligible: editableHost, callback: ([item]) => setIpEdit({ kind: 'hosts-set', name: item.name, ip: item.expected?.[0] || item.system.a || '' }) },
              { id: 'hosts-del', label: 'Remove hosts entry', isDestructive: true, isEligible: editableHost, callback: ([item]) => stage({ kind: 'hosts-del', name: item.name }) },
              { id: 'masq-ip', label: 'Change dnsmasq answer', isEligible: (item) => !!item.dnsmasqKey && !managedHosts.has(item.name), callback: ([item]) => setIpEdit({ kind: 'dnsmasq-set', name: item.name, key: item.dnsmasqKey, ip: item.dnsmasq || '' }) },
              { id: 'masq-del', label: 'Remove dnsmasq rule', isDestructive: true, isEligible: (item) => !!item.dnsmasqKey && !managedHosts.has(item.name), callback: ([item]) => stage({ kind: 'dnsmasq-del', key: item.dnsmasqKey }) },
              { id: 'res-edit', label: 'Edit resolver file', isEligible: (item) => !!item.resolverFile, callback: ([item]) => openResolver(item.resolverFile) },
              { id: 'res-del', label: 'Remove resolver file', isDestructive: true, isEligible: (item) => !!item.resolverFile, callback: ([item]) => stage({ kind: 'resolver-del', file: item.resolverFile }) },
            ]}
            itemKey="name"
            aiWhat={AI_WHAT.observed}
            aiQuestion={AI_ROW_QUESTION.observed}
          />
          {ipEdit && (
            <div className="ps-addrow">
              <div className="ps-suffixfield">
                <input value={ipEdit.kind === 'dnsmasq-set' ? `address=/${ipEdit.key}/` : ipEdit.name} disabled />
                <span>{ipEdit.kind === 'dnsmasq-set' ? '' : '→'}</span>
              </div>
              <input
                className="ps-search"
                autoFocus
                placeholder="IP address"
                value={ipEdit.ip}
                onChange={(e) => setIpEdit({ ...ipEdit, ip: e.target.value.trim() })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && ipEdit.ip) { stage(ipEdit.kind === 'dnsmasq-set' ? { kind: ipEdit.kind, key: ipEdit.key, ip: ipEdit.ip } : { kind: ipEdit.kind, name: ipEdit.name, ip: ipEdit.ip }); setIpEdit(null); }
                  if (e.key === 'Escape') setIpEdit(null);
                }}
              />
              <Button
                __next40pxDefaultSize
                variant="primary"
                disabled={!ipEdit.ip}
                onClick={() => { stage(ipEdit.kind === 'dnsmasq-set' ? { kind: ipEdit.kind, key: ipEdit.key, ip: ipEdit.ip } : { kind: ipEdit.kind, name: ipEdit.name, ip: ipEdit.ip }); setIpEdit(null); }}
              >
                Stage edit
              </Button>
              <Button __next40pxDefaultSize variant="tertiary" onClick={() => setIpEdit(null)}>Cancel</Button>
            </div>
          )}
          {resEdit && (
            <div className="ps-log ps-editor">
              <div className="ps-log__head">
                <span className="ps-mono">/etc/resolver/{resEdit.file}</span>
                <span>
                  <Button size="small" variant="primary" disabled={!resEdit.content.trim()} onClick={() => { stage({ kind: 'resolver-write', file: resEdit.file, content: resEdit.content }); setResEdit(null); }}>Stage edit</Button>
                  <Button size="small" variant="tertiary" onClick={() => setResEdit(null)}>Close</Button>
                </span>
              </div>
              <textarea
                className="ps-editor__area ps-editor__area--short"
                spellCheck={false}
                value={resEdit.content}
                onChange={(e) => setResEdit({ ...resEdit, content: e.target.value })}
              />
            </div>
          )}
          <Text className="ps-hint">Everything the machine declares (hosts file, dnsmasq, resolver files) — including domains other tools own. These files are root-owned, so edits stage into a queue and apply with the one sudo command above (backups are written; dnsmasq restarts and caches flush automatically). "Divergent" = the system resolver and dnsmasq disagree. Rows marked <em>managed</em> belong to the registry at the top — edit them there.</Text>
        </>
      )}
    </Section>
  );
}

function Ports() {
  const { data, error, reload } = useApi('ports');
  if (error) return <PSNotice status="error" isDismissible={false}>{error}</PSNotice>;
  if (!data) return <Spinner />;
  const rows = data.map((r, i) => ({ ...r, _k: `${r.port}-${r.address}-${i}` }));
  const kill = async (item) => {
    if (!window.confirm(`SIGTERM ${item.process} (pid ${item.pid}) holding :${item.port}?`)) return;
    const r = await fetch('/api/ports/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: item.pid }) }).then((x) => x.json());
    if (r.error) window.alert(r.error);
    setTimeout(reload, 800);
  };
  const actions = [
    { id: 'kill', label: 'Stop process (SIGTERM)', isDestructive: true, callback: ([item]) => kill(item), isEligible: (item) => !!item.pid && item.user && item.user !== 'root' },
  ];
  const sectionPrompt = () => aiPrompt({
    subject: `Below, from Dockmaster: ${AI_WHAT.ports}.`,
    body: `A "shared port" means two processes hold the same port on different addresses — a wildcard bind beside a specific one.\n\n${aiTable(PORT_FIELDS, rows)}`,
    question: AI_SECTION_QUESTION,
  });
  return (
    <Section
      title="Listening ports"
      actions={
        <>
          <CopyForAI build={sectionPrompt} what="every listening port" />
          <Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>
        </>
      }
    >
      <PSDataView
        data={rows}
        fields={PORT_FIELDS}
        actions={actions}
        itemKey="_k"
        aiWhat={AI_WHAT.ports}
        aiQuestion={AI_ROW_QUESTION.ports}
      />
      <Text className="ps-hint">A "shared port" means two processes hold the same port on different addresses (a wildcard bind beside a specific one) — fine when intended, a collision when not.</Text>
    </Section>
  );
}

function Services() {
  const { data, error, reload } = useApi('launchd');
  const [panel, setPanel] = useState(null); // { title, lines }
  const [editor, setEditor] = useState(null); // { label, path, text, dirty, busy }
  const [notice, setNotice] = useState(null);
  if (error) return <PSNotice status="error" isDismissible={false}>{error}</PSNotice>;
  if (!data) return <Spinner />;
  const rows = data.filter((j) => j.owned && !j.disabled).map((j) => ({ ...j, _k: `${j.domain}:${j.label}` }));
  const showFile = async (label, kind) => {
    setEditor(null);
    const r = await fetch(`/api/launchd/${encodeURIComponent(label)}/${kind}`).then((x) => x.json());
    setPanel(r.error ? { title: label, lines: [r.error] } : { title: r.path, lines: r.lines });
  };
  const openEditor = async (label) => {
    setPanel(null);
    const r = await fetch(`/api/launchd/${encodeURIComponent(label)}/plist`).then((x) => x.json());
    if (r.error) return setNotice({ status: 'error', text: r.error });
    setEditor({ label, path: r.path, text: r.content ?? r.lines.join('\n'), dirty: false, busy: false });
  };
  const saveEditor = async () => {
    setEditor((e) => ({ ...e, busy: true }));
    const r = await fetch(`/api/launchd/${encodeURIComponent(editor.label)}/plist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editor.text }),
    }).then((x) => x.json());
    if (r.error) {
      setNotice({ status: 'error', text: r.error });
      setEditor((e) => ({ ...e, busy: false }));
    } else {
      setNotice({ status: 'success', text: `${editor.label} saved (plutil-validated). Kickstart it to apply the change.` });
      setEditor((e) => ({ ...e, dirty: false, busy: false }));
      reload();
    }
  };
  const kick = async (label) => {
    const r = await fetch(`/api/launchd/${encodeURIComponent(label)}/kickstart`, { method: 'POST' }).then((x) => x.json());
    setNotice(r.ok ? { status: 'success', text: `${label} kickstarted.` } : { status: 'error', text: r.error || r.stderr || 'Failed.' });
    reload();
  };
  const actions = [
    { id: 'log', label: 'Log', callback: ([item]) => showFile(item.label, 'log'), isEligible: (item) => !!item.log },
    { id: 'edit', label: 'Edit plist', callback: ([item]) => openEditor(item.label), isEligible: (item) => item.domain === 'user' },
    { id: 'plist', label: 'View plist', callback: ([item]) => showFile(item.label, 'plist'), isEligible: (item) => item.domain !== 'user' },
    { id: 'kickstart', label: 'Kickstart', callback: ([item]) => kick(item.label), isEligible: (item) => item.domain === 'user' },
  ];
  const sectionPrompt = () => aiPrompt({
    subject: `Below, from Dockmaster: ${AI_WHAT.services}.`,
    body: aiTable(SERVICE_FIELDS, rows),
    question: AI_SECTION_QUESTION,
  });
  return (
    <Section
      title="Launchd services (yours)"
      actions={
        <>
          <CopyForAI build={sectionPrompt} what="every launchd agent you own" />
          <Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>
        </>
      }
    >
      {notice && <PSNotice status={notice.status} onRemove={() => setNotice(null)}>{notice.text}</PSNotice>}
      <PSDataView
        data={rows}
        fields={SERVICE_FIELDS}
        actions={actions}
        itemKey="_k"
        aiWhat={AI_WHAT.services}
        aiQuestion={AI_ROW_QUESTION.services}
      />
      {panel && (
        <div className="ps-log">
          <div className="ps-log__head">
            <span className="ps-mono">{panel.title}</span>
            <Button size="small" variant="tertiary" onClick={() => setPanel(null)}>Close</Button>
          </div>
          <pre>{panel.lines.join('\n') || '(empty)'}</pre>
        </div>
      )}
      {editor && (
        <div className="ps-log ps-editor">
          <div className="ps-log__head">
            <span className="ps-mono">{editor.path}{editor.dirty ? ' — unsaved' : ''}</span>
            <span>
              <Button size="small" variant="primary" isBusy={editor.busy} disabled={!editor.dirty} onClick={saveEditor}>Save</Button>
              <Button size="small" variant="secondary" onClick={() => kick(editor.label)}>Kickstart</Button>
              <Button size="small" variant="tertiary" onClick={() => setEditor(null)}>Close</Button>
            </span>
          </div>
          <textarea
            className="ps-editor__area"
            spellCheck={false}
            value={editor.text}
            onChange={(e) => setEditor({ ...editor, text: e.target.value, dirty: true })}
          />
        </div>
      )}
    </Section>
  );
}

function Dns() {
  const { data, error, reload } = useApi('dns');
  if (error) return <PSNotice status="error" isDismissible={false}>{error}</PSNotice>;
  if (!data) return <Spinner />;
  const chainState = [
    `NextDNS: ${data.nextdns ? 'running' : 'not detected'}`,
    `dnsmasq: ${data.dnsmasq ? 'running' : 'down'}`,
    `Default upstream nameservers: ${data.defaultNameservers.join(', ') || 'none'}`,
    'Order of authority: browser secure-DNS (if on) → NextDNS (if running) → the scoped resolvers below → default upstream.',
  ].join('\n');
  const sectionPrompt = () => aiPrompt({
    subject: `Below, from Dockmaster: the DNS chain on this machine, and ${AI_WHAT.dns}.`,
    body: `${chainState}\n\n${aiTable(DNS_FIELDS, data.scoped)}`,
    question: AI_SECTION_QUESTION,
  });
  return (
    <Section
      title="DNS chain"
      actions={
        <>
          <CopyForAI build={sectionPrompt} what="the DNS chain" />
          <Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>
        </>
      }
    >
      <div className="ps-dnsrow">
        <Chip tone={data.nextdns ? 'warning' : 'neutral'}>{data.nextdns ? 'NextDNS running' : 'NextDNS not detected'}</Chip>
        <Chip tone={data.dnsmasq ? 'success' : 'error'}>{data.dnsmasq ? 'dnsmasq running' : 'dnsmasq down'}</Chip>
        <Chip>default upstream: {data.defaultNameservers.join(', ') || 'none'}</Chip>
      </div>
      <PSDataView
        data={data.scoped}
        fields={DNS_FIELDS}
        itemKey="id"
        aiWhat={AI_WHAT.dns}
        aiQuestion={AI_ROW_QUESTION.dns}
      />
      <Text className="ps-hint">Order of authority in practice: browser secure-DNS (if on) → NextDNS (if running) → scoped resolvers above → default upstream. When a local name misbehaves, walk this list top-down.</Text>
    </Section>
  );
}

// Every screen owns its permalink (house rule): /ingress, /ports, /services,
// /dns — the server SPA-falls-back all GETs to index.html. /domains was
// absorbed into /ingress; the old slug keeps working.
const SLUG_ALIASES = { domains: 'ingress' };
function usePath() {
  const valid = NAV.map((n) => n.id);
  const fromLocation = () => {
    const raw = window.location.pathname.replace(/^\/+/, '') || 'overview';
    const slug = SLUG_ALIASES[raw] || raw;
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

let noticeId = 0;

export default function App() {
  const [page, setPage] = usePath();
  const [themePref, setThemePref] = useTheme();
  const [notices, setNotices] = useState([]);
  const Page = { overview: Overview, ingress: Ingress, ports: Ports, services: Services, dns: Dns }[page];
  const dismiss = useCallback((id) => setNotices((n) => n.filter((x) => x.id !== id)), []);
  const notify = useCallback((content, status = 'success') => {
    const id = String(++noticeId);
    setNotices((n) => [...n, { id, content, status, spokenMessage: content }]);
    if (status === 'success') setTimeout(() => dismiss(id), 4000);
  }, [dismiss]);
  return (
    <NotifyContext.Provider value={notify}>
    <div className="ps-app">
      <aside className="ps-sidebar">
        <div className="ps-brand">
          <span className="ps-brand__mark">⚓</span>
          <div>
            <strong>Dockmaster</strong>
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
          <span>Dockmaster v{VERSION}</span>
        </div>
      </aside>
      <main className="ps-main">
        <Page go={setPage} />
      </main>
      <div className="ps-notices">
        <SnackbarList notices={notices} onRemove={dismiss} />
      </div>
    </div>
    </NotifyContext.Provider>
  );
}
