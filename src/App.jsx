// Localhost Manager — the app shell (composing-app-shells: brand header, nav,
// version footer) around the views + management of local dev infra.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Notice, SnackbarList, Spinner, __experimentalText as Text } from '@wordpress/components';
import { DataViews, filterSortAndPaginate } from '@wordpress/dataviews';
import {
  Icon,
  chevronLeft,
  cloud,
  cog,
  commentContent,
  globe,
  help,
  home,
  link,
  menu,
  navigation,
  plugins,
  scheduled,
  seen,
} from '@wordpress/icons';
import { AiChatResizeHandle, PopoverSelect } from '@1dr0/ai-chat';
import { generatedIdentityImage, mountEditableProfile, mountEditableProfilePage } from '@1dr0/wpds-identity';
import '@1dr0/wpds-identity/styles.css';
import AssistantPanel from './AssistantPanel.jsx';
import ConversationalField from './ConversationalField.jsx';
import { apiGet } from './api.mjs';

const VERSION = '2.16.0';
const DOCKMASTER_MARK = generatedIdentityImage('mark', 'Localhost Manager');

const NAV = [
  { id: 'overview', label: 'Overview' },
  { id: 'ingress', label: 'Ingress & Domains' },
  { id: 'tlds', label: 'Vanity TLDs' },
  { id: 'ports', label: 'Ports' },
  { id: 'services', label: 'Services' },
  { id: 'remote', label: 'Remote services' },
  { id: 'dns', label: 'DNS chain' },
  { id: 'activity', label: 'Activity' },
];

const NAV_ICONS = { overview: home, ingress: globe, tlds: navigation, ports: link, services: plugins, remote: cloud, dns: seen, activity: scheduled };

const PAGE_META = {
  overview: { eyebrow: 'Local infrastructure', title: 'Overview' },
  ingress: { eyebrow: 'Routing', title: 'Ingress & Domains' },
  tlds: { eyebrow: 'Name resolution', title: 'Vanity TLDs' },
  ports: { eyebrow: 'Network', title: 'Ports' },
  services: { eyebrow: 'Processes', title: 'Services' },
  remote: { eyebrow: 'Remote infrastructure', title: 'Remote services' },
  dns: { eyebrow: 'Name resolution', title: 'DNS chain' },
  activity: { eyebrow: 'Operations', title: 'Activity' },
  help: { eyebrow: 'Localhost Manager', title: 'Help & Feedback' },
  settings: { eyebrow: 'Localhost Manager', title: 'App settings' },
  profile: { eyebrow: 'Profile settings', title: 'Profile' },
};

const OVERVIEW_HEROES = [
  {
    kicker: 'SEE THE WHOLE LOCAL PATH',
    title: 'Know which service owns an address before you change anything.',
    support: 'Localhost Manager connects local domains, ports, launchd services, and DNS into one inspectable path.',
  },
  {
    kicker: 'WORK FROM EVIDENCE',
    title: 'Trace the request from name resolution to the process answering it.',
    support: 'Start with the symptom, follow each layer, then use the narrow control that owns the fix.',
  },
  {
    kicker: 'KEEP LOCAL INFRASTRUCTURE RECOVERABLE',
    title: 'Review state first, stage changes, and keep privileged work bounded.',
    support: 'The interface separates observation, user-owned changes, and validated privileged application.',
  },
];

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

// Waypoint uses a resizable 304px sidebar and a persistent 72px icon rail.
const SIDEBAR_KEY = 'dockmaster-sidebar-collapsed';
const SIDEBAR_WIDTH_KEY = 'dockmaster-sidebar-width-waypoint';
const SIDEBAR_WIDTH_MIN = 240;
const SIDEBAR_WIDTH_MAX = 400;
const SIDEBAR_WIDTH_DEFAULT = 304;
const TIP_KEY = 'dockmaster-waypoint-tip-dismissed';

function FooterProfile({ onOpen }) {
  const host = useRef(null);
  useEffect(() => {
    if (!host.current) return undefined;
    return mountEditableProfile(host.current, {
      appId: 'dockmaster',
      profile: { displayName: 'Local operator', secondary: 'Local infrastructure' },
      onOpen,
    }).destroy;
  }, [onOpen]);
  return <div ref={host} className="ps-local-profile" />;
}

function ProfilePage({ onDone }) {
  const host = useRef(null);
  useEffect(() => {
    if (!host.current) return undefined;
    return mountEditableProfilePage(host.current, {
      appId: 'dockmaster',
      profile: { displayName: 'Local operator', secondary: 'Local infrastructure' },
      title: 'Localhost Manager profile',
      description: 'Choose the local identity shown in Localhost Manager.',
      onCancel: onDone,
      onSaved: onDone,
    }).destroy;
  }, [onDone]);
  return <div ref={host} className="ps-profile-page" />;
}

const boundSidebarWidth = (value) => Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Number(value) || SIDEBAR_WIDTH_DEFAULT));

function readSidebarWidth() {
  return boundSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY));
}

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
        <button
          key={t}
          type="button"
          className={pref === t ? 'is-active' : ''}
          aria-pressed={pref === t}
          onClick={() => onChange(t)}
        >
          {t[0].toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
}

function AppearanceShortcut({ pref, onOpen }) {
  return (
    <button type="button" className="ps-appearance" onClick={onOpen}>
      <span className="ps-appearance__copy"><small>Appearance</small><strong>{pref[0].toUpperCase() + pref.slice(1)}</strong></span>
      <span aria-hidden="true">›</span>
    </button>
  );
}

function useApi(path, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(() => {
    setError(null);
    apiGet(path).then(setData).catch((e) => setError(String(e)));
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
  'I run a dashboard called Localhost Manager over it: listening ports, the local domains this machine declares (in /etc/hosts, dnsmasq, and /etc/resolver files), a root Caddy ingress that serves *.test over HTTPS to local ports, launchd agents, and the DNS resolution chain.',
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

function Section({ title, actions, children, className = '' }) {
  return (
    <section className={`ps-section${className ? ` ${className}` : ''}`}>
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
  {
    id: 'service',
    label: 'Service',
    enableGlobalSearch: true,
    getValue: ({ item }) => item.service || '',
    aiValue: (item) => (
      !item.service ? 'none linked'
        : item.serviceState?.missing ? `${item.service} (agent missing)`
        : item.serviceState?.disabled ? `${item.service} (disabled)`
        : item.serviceState?.running ? `${item.service} (running)`
        : `${item.service} (stopped)`
    ),
    render: ({ item }) => (
      !item.service ? <span className="ps-mono">—</span> : (
        <span className="ps-listeners">
          <span className="ps-mono">{item.service}</span>
          {item.serviceState?.missing ? <Chip tone="error">missing</Chip>
            : item.serviceState?.disabled ? <Chip>disabled</Chip>
            : item.serviceState?.running ? <Chip tone="success">running</Chip>
            : <Chip tone="warning">stopped</Chip>}
        </span>
      )
    ),
  },
  { id: 'cert', label: 'Cert', getValue: ({ item }) => (item.cert ? 'minted' : 'missing'), render: ({ item }) => (item.cert ? <Chip tone="success">minted</Chip> : <Chip tone="error">missing</Chip>) },
  { id: 'dns', label: 'DNS', getValue: ({ item }) => item.dns, aiValue: (item) => (item.dns === 'ok' ? 'resolving' : 'pending apply'), render: ({ item }) => (item.dns === 'ok' ? <Chip tone="success">resolving</Chip> : <Chip tone="warning">pending apply</Chip>) },
  { id: 'upstream', label: 'Status', getValue: ({ item }) => item.upstream, aiValue: (item) => (item.upstream === 'up' ? 'upstream up' : 'upstream down'), render: ({ item }) => (item.upstream === 'up' ? <Chip tone="success">upstream up</Chip> : <Chip tone="warning">upstream down</Chip>) },
  // Some apps are two services behind one origin. Showing the extra routes
  // beside the main upstream is what makes "this domain fans out" legible.
  {
    id: 'routes',
    label: 'Routes',
    enableSorting: false,
    getValue: ({ item }) => (item.routes || []).map((r) => `${r.path}→${r.port}`).join(', '),
    aiValue: (item) => ((item.routes || []).length
      ? `${item.routes.map((r) => `${r.path} to port ${r.port}`).join('; ')}, everything else to ${item.port}`
      : `everything to port ${item.port}`),
    render: ({ item }) => ((item.routes || []).length
      ? <span className="ps-listeners">{item.routes.map((r) => <span key={r.path} className="ps-chip ps-chip--mono">{r.path} → {r.port}</span>)}</span>
      : <span className="ps-mono">—</span>),
  },
  // Cert, DNS, and upstream can all read healthy while the browser still
  // cannot open the address, because the system proxy claims the name first.
  // Without this column that failure has no row to land on.
  {
    id: 'browser',
    label: 'Browser',
    getValue: ({ item }) => item.browser,
    aiValue: (item) => (item.browser === 'shadowed'
      ? 'unreachable in the browser: the system proxy claims this name because its suffix is not in the proxy bypass list'
      : 'reachable directly'),
    render: ({ item }) => (item.browser === 'shadowed'
      ? <Chip tone="error">blocked</Chip>
      : <Chip tone="success">direct</Chip>),
  },
];

const DOCKER_FIELDS = [
  {
    id: 'service',
    label: 'Service',
    enableGlobalSearch: true,
    getValue: ({ item }) => `${item.service} ${item.container} ${item.image}`,
    aiValue: (item) => `${item.service} (container ${item.container}, image ${item.image})`,
    render: ({ item }) => (
      <span>
        <strong>{item.service}</strong>
        <span className="ps-cell-detail ps-mono">{item.project || 'standalone'} · {item.container}</span>
      </span>
    ),
  },
  {
    id: 'published',
    label: 'Published port',
    getValue: ({ item }) => item.hostPort,
    aiValue: (item) => `${item.hostIp || '*'}:${item.hostPort} → ${item.containerPort}/tcp${item.publicBind ? ' (all host interfaces)' : ''}`,
    render: ({ item }) => (
      <span className="ps-listeners">
        <span className="ps-mono">{item.publicBind ? '*' : item.hostIp}:{item.hostPort} → {item.containerPort}/tcp</span>
        {item.publicBind && <Chip tone="warning">all interfaces</Chip>}
      </span>
    ),
  },
  {
    id: 'web',
    label: 'Web probe',
    getValue: ({ item }) => `${item.protocol} ${item.statusCode || ''}`.trim(),
    aiValue: (item) => `${item.protocol.toUpperCase()} responded${item.statusCode ? ` with ${item.statusCode}` : ''}`,
    render: ({ item }) => <Chip tone="success">{item.protocol.toUpperCase()} {item.statusCode || 'responding'}</Chip>,
  },
  {
    id: 'state',
    label: 'Container',
    getValue: ({ item }) => item.health || item.state,
    aiValue: (item) => item.health ? `${item.state}, health ${item.health}` : item.state,
    render: ({ item }) => {
      const state = item.health || item.state;
      const tone = state === 'healthy' || state === 'running' ? 'success' : state === 'unhealthy' ? 'error' : 'warning';
      return <Chip tone={tone}>{state}</Chip>;
    },
  },
  {
    id: 'ingress',
    label: 'Ingress',
    enableSorting: false,
    getValue: ({ item }) => item.ingressDomains.map((domain) => domain.host).join(', '),
    aiValue: (item) => item.ingressDomains.length ? item.ingressDomains.map((domain) => domain.host).join(', ') : 'not registered',
    render: ({ item }) => (
      item.ingressDomains.length
        ? <span className="ps-listeners">{item.ingressDomains.map((domain) => <a key={domain.host} className="ps-mono" href={domain.url} target="_blank" rel="noreferrer">{domain.host}</a>)}</span>
        : <Chip tone="warning">not registered</Chip>
    ),
  },
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

// A new agent, as the form holds it. The server takes a structured spec, so
// the free-text fields are parsed here rather than sent raw.
const NEW_AGENT = { label: '', command: '', cwd: '', env: '', keepAlive: 'always', runAtLoad: true };

// Split a command line on whitespace, keeping quoted runs together, so an
// argument containing a space survives ("--msg 'hello world'").
function splitCommand(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function parseEnv(text) {
  const env = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

function agentSpecFromDraft(draft) {
  const env = parseEnv(draft.env);
  return {
    label: draft.label.trim(),
    program: splitCommand(draft.command.trim()),
    workingDirectory: draft.cwd.trim() || undefined,
    environment: Object.keys(env).length ? env : undefined,
    keepAlive: draft.keepAlive,
    runAtLoad: draft.runAtLoad,
    comment: 'Created with Localhost Manager.',
  };
}

const SERVICE_FIELDS = [
  { id: 'label', label: 'Label', getValue: ({ item }) => item.label, render: ({ item }) => <span className="ps-mono">{item.label}</span>, enableGlobalSearch: true },
  { id: 'domain', label: 'Domain', getValue: ({ item }) => item.domain },
  {
    id: 'state',
    label: 'State',
    getValue: ({ item }) => (item.disabled ? -1 : item.running ? 2 : item.keepAlive ? 0 : 1),
    aiValue: (item) => (
      item.domain === 'system' ? 'root — state needs sudo'
        : item.disabled ? 'disabled (plist parked under a suffix; enable to use it)'
        : item.running ? `running (pid ${item.pid})`
        : item.keepAlive ? 'not running, but KeepAlive is set'
        : 'idle'
    ),
    render: ({ item }) => (
      item.domain === 'system' ? <Chip>root — state needs sudo</Chip>
        : item.disabled ? <Chip>disabled</Chip>
        : item.running ? <Chip tone="success">running · pid {item.pid}</Chip>
        : <Chip tone={item.keepAlive ? 'error' : 'neutral'}>{item.keepAlive ? 'not running (KeepAlive!)' : 'idle'}</Chip>
    ),
  },
  { id: 'lastExit', label: 'Last exit', getValue: ({ item }) => item.lastExit ?? '', render: ({ item }) => <span className="ps-mono">{item.lastExit ?? '—'}</span> },
];

const REMOTE_SERVICE_FIELDS = [
  {
    id: 'service',
    label: 'Service',
    enableGlobalSearch: true,
    getValue: ({ item }) => `${item.projectId} ${item.name} ${item.containerProject}`,
    render: ({ item }) => (
      <span>
        <strong>{item.name}</strong>
        <span className="ps-cell-detail ps-mono">{item.projectId} · {item.containerProject}</span>
      </span>
    ),
  },
  {
    id: 'state',
    label: 'State',
    getValue: ({ item }) => item.state,
    render: ({ item }) => {
      const tone = item.state === 'running' ? 'success' : item.state === 'mixed' ? 'warning' : item.state === 'exited' || item.state === 'missing' ? 'error' : 'neutral';
      return <Chip tone={tone}>{item.state}</Chip>;
    },
  },
  {
    id: 'health',
    label: 'Health',
    getValue: ({ item }) => item.health || 'not declared',
    render: ({ item }) => {
      const tone = item.health === 'healthy' ? 'success' : item.health === 'unhealthy' ? 'error' : item.health === 'mixed' || item.health === 'starting' ? 'warning' : 'neutral';
      return <Chip tone={tone}>{item.health || 'not declared'}</Chip>;
    },
  },
  { id: 'image', label: 'Image', getValue: ({ item }) => item.image || 'none', render: ({ item }) => <span className="ps-mono">{item.image || 'none'}</span>, enableGlobalSearch: true },
  {
    id: 'ports',
    label: 'Published ports',
    enableSorting: false,
    getValue: ({ item }) => item.ports.map((port) => `${port.hostIp || '*'}:${port.hostPort || '-'} to ${port.containerPort}/${port.protocol}`).join(', '),
    render: ({ item }) => item.ports.length
      ? <span className="ps-listeners">{item.ports.map((port, index) => <span key={`${port.containerPort}-${index}`} className="ps-chip ps-chip--mono">{port.hostIp || '*'}:{port.hostPort || '-'} to {port.containerPort}/{port.protocol}</span>)}</span>
      : <span className="ps-mono">internal only</span>,
  },
  {
    id: 'authority',
    label: 'Authority',
    getValue: ({ item }) => item.actions.join(', ') || 'read only',
    render: ({ item }) => (
      <span className="ps-remote-actions" aria-label={`Allowed actions: ${item.actions.join(', ') || 'none'}`}>
        {['start', 'stop', 'restart', 'pull'].map((action) => (
          <button
            key={action}
            type="button"
            disabled={!item.actions.includes(action)}
            onClick={() => item.runAction(action)}
          >
            {action}
          </button>
        ))}
      </span>
    ),
  },
];

const DNS_FIELDS = [
  { id: 'domain', label: 'Scoped domain', getValue: ({ item }) => item.domain, aiValue: (item) => `*.${item.domain}`, render: ({ item }) => <span className="ps-mono">*.{item.domain}</span>, enableGlobalSearch: true },
  { id: 'ns', label: 'Nameserver', enableSorting: false, getValue: ({ item }) => item.nameservers.join(', ') || '—', render: ({ item }) => <span className="ps-mono">{item.nameservers.join(', ') || '—'}</span> },
  { id: 'flags', label: 'Flags', getValue: ({ item }) => item.flags || '' },
];

const TLD_FIELDS = [
  { id: 'tld', label: 'TLD', getValue: ({ item }) => item.tld, aiValue: (item) => `*.${item.tld}`, render: ({ item }) => <span className="ps-mono">*.{item.tld}</span>, enableGlobalSearch: true },
  { id: 'kind', label: 'Kind', getValue: ({ item }) => (item.builtin ? 'builtin' : 'vanity'), render: ({ item }) => (item.builtin ? <Chip>builtin</Chip> : <Chip tone="success">vanity</Chip>) },
  {
    id: 'resolver',
    label: 'Resolver file',
    getValue: ({ item }) => (item.resolverPending ? 'pending apply' : item.resolver ? 'installed' : 'missing'),
    aiValue: (item) => (item.resolverPending ? 'staged, pending sudo apply' : item.resolver ? `installed (/etc/resolver/${item.tld})` : 'missing'),
    render: ({ item }) => (
      item.resolverPending ? <Chip tone="warning">pending apply</Chip>
        : item.resolver ? <Chip tone="success">/etc/resolver/{item.tld}</Chip>
        : <Chip tone="error">missing</Chip>
    ),
  },
  { id: 'sites', label: 'Sites', getValue: ({ item }) => item.sites, aiValue: (item) => (item.hosts?.length ? item.hosts.join(', ') : '0'), render: ({ item }) => <span className="ps-mono">{item.sites}</span> },
];

// What each table holds, in the words the prompt uses — shared by the row
// action and the section button so both frame the data the same way.
const AI_WHAT = {
  domains: 'the domains registered with my local ingress (each one is a user-owned Caddy site block with an mkcert certificate, reverse-proxying HTTPS to a port on 127.0.0.1; the suffix is .test or a registered vanity TLD; a domain can be linked to the launchd agent that serves its upstream, which Localhost Manager can start and stop)',
  docker: 'the running Docker containers with published host TCP ports that responded to an HTTP or HTTPS probe, making them candidates for the local Caddy ingress',
  observed: 'the full list of local domain names this machine declares anywhere — /etc/hosts, dnsmasq rules, and /etc/resolver files — alongside what the system resolver and dnsmasq each answer, and which processes are listening on the address it resolves to',
  tlds: 'the top-level suffixes my local ingress will serve — .test (the builtin, RFC-reserved default) plus any vanity TLDs I have registered; each vanity TLD is an /etc/resolver/<tld> file routing the whole suffix to the local resolver, under which individual sites are registered',
  ports: 'the TCP ports currently being listened on by this machine',
  services: 'the launchd agents I own on this machine, including disabled ones (their plist is parked under a .disabled suffix so login skips them)',
  remote: 'the explicitly allowlisted Docker Compose services on dk-sin1 returned by Localhost Manager through its forced-command SSH provider',
  dns: 'the scoped DNS resolvers configured in /etc/resolver, which send matching domains to a specific nameserver instead of the default upstream',
};

const AI_ROW_QUESTION = {
  domains: 'What is this domain about — what is likely running on that upstream port, and does anything here look wrong (missing certificate, DNS not resolving yet, upstream down, or a linked service that should be started)?',
  docker: 'What does this Docker service appear to be, is its published-port exposure appropriate, and should I register it with the local ingress?',
  observed: 'What is this entry about — what most likely created it, what would still depend on it, and would it be safe to remove? Flag it if the entry looks stale, or if the system resolver and dnsmasq disagree.',
  tlds: 'What is this suffix for, is its resolver file in place, and does anything look off — a vanity TLD with no sites, or a resolver file still pending a privileged apply?',
  ports: 'What is this process, and why would it be listening on this port? Tell me whether it is something a developer typically installs deliberately, what would break if I stopped it, and whether the port or bind address is a problem.',
  services: 'What does this launchd agent most likely do, what would break if I unloaded it, and does its state look healthy? A non-zero last exit code or a KeepAlive job that is not running means something is wrong — say so.',
  remote: 'Does this remote service state look healthy, and are its exposed ports and currently allowlisted actions appropriate?',
  dns: 'What does this scoped resolver do, and is this a sensible configuration for local development? Tell me what would stop working if I removed it.',
};

// Overview's copy button takes the whole machine, not just the four numbers
// on screen — it pulls every view so one paste gives the assistant the ports,
// the domains, the agents and the DNS chain together.
async function machineSnapshot() {
  const [overview, ingress, observed, ports, services, dns] = await Promise.all([
    get('overview'), get('ingress'), get('domains'), get('ports'), get('launchd'), get('dns'),
  ]);
  const mine = services.filter((j) => j.owned);
  return aiPrompt({
    subject: 'Below is a full snapshot of the machine, taken from every view in Localhost Manager.',
    body: [
      '## Summary',
      `Listening ports: ${overview.counts.ports}${overview.counts.sharedPorts ? ` (${overview.counts.sharedPorts} shared between processes)` : ''}`,
      `Local domains declared: ${overview.counts.domains}`,
      `Launchd agents I own: ${mine.length}, ${mine.filter((j) => j.running).length} running, ${mine.filter((j) => j.disabled).length} disabled (the machine has ${overview.counts.services} launchd jobs in total, counting system ones)`,
      `DNS chain: ${[dns.nextdns && 'NextDNS', dns.dnsmasq && 'dnsmasq', 'system'].filter(Boolean).join(' → ')}`,
      `Ingress daemon: ${ingress.ingress.up ? `up on ${ingress.ingress.aliasIp} + ${ingress.ingress.aliasIp6}` : 'DOWN'}`,
      '',
      `## Registered ingress domains (${ingress.domains.length})`,
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
  const [hero, setHero] = useState(0);
  useEffect(() => {
    if ( window.matchMedia('(prefers-reduced-motion: reduce)').matches ) return;
    const timer = window.setInterval(() => setHero((value) => (value + 1) % OVERVIEW_HEROES.length), 7000);
    return () => window.clearInterval(timer);
  }, []);
  if (error) return <PSNotice status="error" isDismissible={false}>{error}</PSNotice>;
  if (!data) return <Spinner />;
  const { counts, dns } = data;
  const heroCopy = OVERVIEW_HEROES[hero];
  const cards = [
    { id: 'ports', label: 'Listening ports', value: counts.ports, sub: counts.sharedPorts ? `${counts.sharedPorts} shared between processes` : 'no shared ports' },
    { id: 'ingress', label: 'Local domains', value: counts.domains, sub: 'hosts, dnsmasq, resolver files' },
    { id: 'services', label: 'Launchd services', value: counts.services, sub: `${counts.running} running (user domain)` },
    { id: 'dns', label: 'DNS layers', value: (dns.nextdns ? 1 : 0) + (dns.dnsmasq ? 1 : 0) + 1, sub: [dns.nextdns && 'NextDNS', dns.dnsmasq && 'dnsmasq', 'system'].filter(Boolean).join(' → ') },
  ];
  return (
    <div className="ps-overview">
      <section className="ps-overview__hero">
        <div>
          <p className="ps-overview__kicker">{heroCopy.kicker}</p>
          <h2>{heroCopy.title}</h2>
          <p>{heroCopy.support}</p>
        </div>
        <Button __next40pxDefaultSize variant="primary" onClick={() => go('ingress')}>Trace a domain</Button>
      </section>
      <section className="ps-quick-start" aria-labelledby="ps-quick-start-title">
        <div className="ps-section-heading">
          <p className="ps-eyebrow">Quick Start</p>
          <h2 id="ps-quick-start-title">What needs attention?</h2>
        </div>
        <div className="ps-journeys">
          <button type="button" className="ps-journey is-primary" onClick={() => go('ingress')}><span className="ps-journey__number">01</span><span><strong>Connect a local address</strong><small>Discover the service, register its domain, and verify the route.</small></span><span className="ps-journey__path">Discover → register → verify</span><span className="ps-journey__arrow" aria-hidden="true">›</span></button>
          <button type="button" className="ps-journey" onClick={() => go('ports')}><span className="ps-journey__number">02</span><span><strong>Investigate a port collision</strong><small>See every listener, ownership boundary, and shared binding before acting.</small></span><span className="ps-journey__path">Find → compare → contain</span><span className="ps-journey__arrow" aria-hidden="true">›</span></button>
          <button type="button" className="ps-journey" onClick={() => go('services')}><span className="ps-journey__number">03</span><span><strong>Restore a local service</strong><small>Check state and logs, then use the narrow lifecycle action for that agent.</small></span><span className="ps-journey__path">Check → review → recover</span><span className="ps-journey__arrow" aria-hidden="true">›</span></button>
        </div>
      </section>
      <Section
        title="Machine snapshot"
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
    </div>
  );
}

function HelpPage() {
  return (
    <Section title="Help & Feedback">
      <p>Start on Overview, choose the task that matches the symptom, then follow the linked inspection pages. Localhost Manager keeps observation separate from user-owned and privileged changes. Repository setup, recovery, and operating notes live in README.md.</p>
      <p className="ps-hint">This loopback app has no public feedback service. Record product feedback in the repository you used to start Localhost Manager.</p>
    </Section>
  );
}

function SettingsPage({ themePref, onThemeChange }) {
  return (
    <Section title="App settings">
      <div className="ps-settings-group">
        <ConversationalField
          label="How should Localhost Manager look?"
          description="Follow your Mac automatically, or keep this local dashboard light or dark. This changes Localhost Manager only."
        >
          <ThemeSwitch pref={themePref} onChange={onThemeChange} />
        </ConversationalField>
      </div>
    </Section>
  );
}

// The management half (absorbed from Local Ingress): the registry drives
// user-owned Caddy site blocks + mkcert certs; the root daemon's
// caddy --watch applies changes live. DNS/hosts lines and privileged-file
// edits enter fixed queues consumed by the validated root auto-apply job.
// The observed-domains diagnostics live here too.
function Ingress() {
  const { data, error, reload } = useApi('ingress');
  const docker = useApi('docker/services');
  const observed = useApi('domains');
  const staged = useApi('observed/edits');
  const tlds = useApi('tlds');
  const [name, setName] = useState('');
  const [tld, setTld] = useState('test');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmHost, setConfirmHost] = useState(null);
  const [edit, setEdit] = useState(null); // { originalHost, name, tld, port }
  const [svcEdit, setSvcEdit] = useState(null); // { host, service }
  const [ipEdit, setIpEdit] = useState(null); // { kind, name, key?, ip }
  const [resEdit, setResEdit] = useState(null); // { file, content, busy }
  const [proxyBusy, setProxyBusy] = useState(false);
  const [routeEdit, setRouteEdit] = useState(null); // { host, rows: [{ path, port }] }
  const domainNameInput = useRef(null);
  if (error) return <PSNotice status="error" isDismissible={false}>{error}</PSNotice>;
  if (!data) return <Spinner />;
  const refreshAll = () => { reload(); docker.reload(); observed.reload(); staged.reload(); tlds.reload(); };
  const refreshAfterApply = () => {
    refreshAll();
    if (data.autoApply) {
      setTimeout(refreshAll, 900);
      setTimeout(refreshAll, 2600);
      setTimeout(refreshAll, 5000);
    }
  };
  const add = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch('/api/ingress/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tld, port: Number(port) }),
      }).then(async (x) => { const b = await x.json(); if (!x.ok) throw new Error(b.error); return b; });
      setNotice({
        status: 'success',
        text: data.autoApply
          ? `${r.host} registered. DNS and hosts are applying automatically.`
          : `${r.host} registered. Apply the staged DNS and hosts lines to finish.`,
      });
      setName('');
      setPort('');
      refreshAfterApply();
    } catch (e) {
      setNotice({ status: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (host) => {
    setConfirmHost(null);
    await fetch(`/api/ingress/domains/${encodeURIComponent(host)}`, { method: 'DELETE' });
    refreshAfterApply();
  };
  const saveDomain = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/ingress/domains/${encodeURIComponent(edit.originalHost)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: `${edit.name}.${edit.tld}`, port: Number(edit.port) }),
      }).then(async (x) => { const b = await x.json(); if (!x.ok) throw new Error(b.error); return b; });
      setNotice({
        status: 'success',
        text: (r.previousHost || edit.originalHost) === r.host
          ? `${r.host} now proxies 127.0.0.1:${r.port}.`
          : data.autoApply
            ? `${r.previousHost || edit.originalHost} renamed to ${r.host}. DNS cleanup is applying automatically.`
            : `${r.previousHost || edit.originalHost} renamed to ${r.host}. Apply the staged DNS changes to finish.`,
      });
      setEdit(null);
      refreshAfterApply();
    } catch (e) {
      setNotice({ status: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  // Linked-service management: link/unlink writes the registry (no Caddy
  // reload needed); start/stop drive launchctl through the same endpoints
  // the Services screen uses, then re-probe so the upstream chip catches up.
  const saveService = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/ingress/domains/${encodeURIComponent(svcEdit.host)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: svcEdit.service }),
      }).then(async (x) => { const b = await x.json(); if (!x.ok) throw new Error(b.error); return b; });
      setNotice({ status: 'success', text: r.service ? `${r.host} is now backed by ${r.service}.` : `${r.host} has no linked service now.` });
      setSvcEdit(null);
      reload();
    } catch (e) {
      setNotice({ status: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  // Extra routes: send one path prefix to a different local port. Saved on
  // the same PATCH as the rest of the domain, so Caddy picks it up live.
  const saveRoutes = async () => {
    setBusy(true);
    try {
      const routes = routeEdit.rows
        .filter((row) => row.path.trim() || String(row.port).trim())
        .map((row) => ({ path: row.path.trim(), port: Number(row.port) }));
      const r = await fetch(`/api/ingress/domains/${encodeURIComponent(routeEdit.host)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routes }),
      }).then(async (x) => { const b = await x.json(); if (!x.ok) throw new Error(b.error); return b; });
      setNotice({
        status: 'success',
        text: r.routes.length
          ? `${r.host} now sends ${r.routes.map((x) => `${x.path} to ${x.port}`).join(', ')}, everything else to ${r.port}.`
          : `${r.host} sends everything to ${r.port} again.`,
      });
      setRouteEdit(null);
      reload();
    } catch (e) {
      setNotice({ status: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const svcAction = async (label, verb) => {
    const r = await fetch(`/api/launchd/${encodeURIComponent(label)}/${verb}`, { method: 'POST' }).then((x) => x.json());
    setNotice(r.ok
      ? { status: 'success', text: `${label} ${verb === 'start' ? 'started' : 'stopped'} — the upstream probe refreshes in a moment.` }
      : { status: 'error', text: r.error || 'Failed.' });
    setTimeout(reload, 900);
  };
  // Observed-domain management: the server writes intent to a user-owned
  // queue. The root helper validates it again before touching privileged files.
  const stage = async (body) => {
    const r = await fetch('/api/observed/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.error) {
      setNotice({ status: 'error', text: r.error });
    } else if (data.autoApply) {
      setNotice({ status: 'success', text: 'Edit queued for automatic apply.' });
    }
    refreshAfterApply();
  };
  const unstage = async (id) => {
    await fetch(`/api/observed/edits/${id}`, { method: 'DELETE' });
    staged.reload();
  };
  // Proxy bypass: exempt every registered suffix on every network service.
  // Unlike the hosts/dnsmasq/resolver edits this usually needs no password —
  // networksetup accepts proxy writes from an admin account — so the button
  // does the work rather than printing a command. A service that refuses
  // falls back to the same validated queue the other privileged edits use.
  const fixBypass = async () => {
    setProxyBusy(true);
    setNotice(null);
    try {
      const r = await fetch('/api/proxy/bypass', { method: 'POST' }).then((x) => x.json());
      const applied = (r.applied || []).map((item) => item.service);
      if (r.ok && applied.length) {
        setNotice({ status: 'success', text: `Proxy bypass updated on ${applied.join(' and ')}. ${r.hint || ''}`.trim() });
      } else if (r.ok) {
        setNotice({ status: 'info', text: 'Every registered suffix was already exempt from the proxy.' });
      } else if ((r.staged || []).length) {
        setNotice({ status: 'warning', text: `${r.staged.join(' and ')} refused a direct change, so it is queued for the privileged worker instead.` });
      } else {
        setNotice({ status: 'error', text: (r.errors || []).join(' ') || 'The proxy bypass did not change.' });
      }
      refreshAfterApply();
    } catch (e) {
      setNotice({ status: 'error', text: e.message });
    } finally {
      setProxyBusy(false);
    }
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
    'proxy-bypass-set': `proxy: ${e.service} bypass → ${(e.domains || []).join(', ')}`,
  })[e.kind] || e.kind;
  const managedHosts = new Set(data.domains.map((d) => d.host));
  const dockerRows = (docker.data?.services || []).map((service) => ({
    ...service,
    ingressDomains: data.domains.filter((domain) => Number(domain.port) === service.hostPort),
  }));
  const prefillDockerDomain = (service) => {
    let candidate = service.suggestedName;
    let suffix = 2;
    while (managedHosts.has(`${candidate}.${tld}`)) {
      candidate = `${service.suggestedName}-${suffix}`;
      suffix += 1;
    }
    setName(candidate);
    setPort(String(service.hostPort));
    setNotice({ status: 'info', text: `${service.service} is ready to register. Confirm the domain name and suffix, then add it.` });
    requestAnimationFrame(() => {
      domainNameInput.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      domainNameInput.current?.focus();
      domainNameInput.current?.select();
    });
  };
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
  const proxy = data.proxy;
  const shadowed = data.domains.filter((d) => d.browser === 'shadowed');
  const ingressState = [
    `Ingress daemon: ${data.ingress.up ? 'up' : 'DOWN'}, serving on ${data.ingress.aliasIp} + ${data.ingress.aliasIp6}`,
    proxy.on
      ? `System proxy: ON${proxy.server ? ` (SOCKS ${proxy.server})` : ''}${proxy.pac ? ' via an auto-config file' : ''}. Exempt suffixes: ${proxy.suffixes.filter((x) => x.covered).map((x) => x.entry).join(', ') || 'none'}. Suffixes the proxy still claims: ${proxy.gaps.join(', ') || 'none'}.`
      : 'System proxy: off, so every local address is reached directly.',
    shadowed.length
      ? `Registered domains unreachable in the browser because the proxy claims the name: ${shadowed.map((d) => d.host).join(', ')}`
      : 'Registered domains unreachable in the browser: none',
    `Privileged queue auto-apply: ${data.autoApply ? 'enabled' : 'not installed'}`,
    `Staged DNS/hosts lines waiting for a privileged apply: ${data.dnsPending.length}`,
    stagedEdits.length ? `Staged edits to privileged files: ${stagedEdits.map(describeEdit).join('; ')}` : 'Staged edits to privileged files: none',
  ].join('\n');
  const registeredBlock = () => aiPrompt({
    subject: `Below, from Localhost Manager: ${AI_WHAT.domains}.`,
    body: `${ingressState}\n\n${aiTable(DOMAIN_FIELDS, data.domains)}`,
    question: AI_SECTION_QUESTION,
  });
  const dockerBlock = () => aiPrompt({
    subject: `Below, from Localhost Manager: ${AI_WHAT.docker}.`,
    body: aiTable(DOCKER_FIELDS, dockerRows),
    question: AI_SECTION_QUESTION,
  });
  const observedBlock = () => aiPrompt({
    subject: `Below, from Localhost Manager: ${AI_WHAT.observed}.`,
    body: `${ingressState}\n\n${aiTable(observedFields, observed.data || [])}`,
    question: AI_SECTION_QUESTION,
  });
  const wholeScreen = () => aiPrompt({
    subject: 'Below is the whole "Ingress & Domains" view from Localhost Manager: Docker web services discovered from published ports, domains registered with my local ingress, and every local domain name this machine declares.',
    body: [
      ingressState,
      '',
      `## Registered ingress domains (${data.domains.length})`,
      aiTable(DOMAIN_FIELDS, data.domains),
      '',
      `## Detected Docker web services (${dockerRows.length})`,
      aiTable(DOCKER_FIELDS, dockerRows),
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
        <Chip tone={data.autoApply ? 'success' : 'warning'}>
          {data.autoApply ? 'auto-apply on' : 'auto-apply off'}
        </Chip>
        <Chip>{data.ingress.aliasIp} + {data.ingress.aliasIp6}</Chip>
        {proxy.on && (
          <Chip tone={proxy.gaps.length ? 'error' : 'success'}>
            {proxy.gaps.length ? `proxy shadows ${proxy.gaps.length} suffix${proxy.gaps.length > 1 ? 'es' : ''}` : 'proxy bypassed for local suffixes'}
          </Chip>
        )}
      </div>
      {!data.ingress.up && (
        <PSNotice
          status="error"
          isDismissible={false}
          spokenMessage="The root ingress daemon is not serving. One privileged install brings up ingress and auto-apply."
        >
          <SudoSteps intro="One privileged install brings up ingress and the automatic DNS queue worker." command={data.installCommand} />
        </PSNotice>
      )}
      {data.ingress.up && !data.autoApply && (
        <PSNotice
          status="warning"
          isDismissible={false}
          spokenMessage="Automatic privileged changes are not installed. One privileged install enables them."
        >
          <SudoSteps intro="One privileged install enables validated automatic DNS, hosts, and resolver updates. No password or Keychain environment variable is stored." command={data.installCommand} />
        </PSNotice>
      )}
      {data.dnsPending.length > 0 && (
        <PSNotice
          status="warning"
          isDismissible={false}
          spokenMessage={data.autoApply
            ? `${data.dnsPending.length} DNS or hosts line${data.dnsPending.length > 1 ? 's are' : ' is'} queued for automatic apply.`
            : `${data.dnsPending.length} staged DNS or hosts line${data.dnsPending.length > 1 ? 's' : ''} need one privileged apply.`}
        >
          {data.autoApply
            ? `${data.dnsPending.length} DNS/hosts line${data.dnsPending.length > 1 ? 's are' : ' is'} queued. The root worker applies them automatically.`
            : <SudoSteps intro={`${data.dnsPending.length} staged DNS/hosts line${data.dnsPending.length > 1 ? 's' : ''} need one privileged apply.`} command={data.applyDnsCommand} />}
        </PSNotice>
      )}
      {shadowed.length > 0 && (
        <PSNotice
          status="error"
          isDismissible={false}
          spokenMessage={`${shadowed.length} registered domain${shadowed.length > 1 ? 's are' : ' is'} served correctly but unreachable in the browser, because the system proxy claims the name.`}
        >
          <p className="ps-sudosteps__intro">
            {shadowed.length === 1 ? `${shadowed[0].host} is` : `${shadowed.length} registered domains are`}{' '}
            served correctly here but will not open in a browser. The system proxy is on, and{' '}
            {proxy.gaps.join(', ')} {proxy.gaps.length > 1 ? 'are' : 'is'} not exempt from it, so the browser hands the
            name to the proxy instead of resolving it on this machine. Chrome reports that as
            {' '}<code>ERR_SOCKS_CONNECTION_FAILED</code>.
          </p>
          <div className="ps-field-actions">
            <Button __next40pxDefaultSize variant="primary" isBusy={proxyBusy} onClick={fixBypass}>
              Exempt these suffixes from the proxy
            </Button>
          </div>
        </PSNotice>
      )}
      {notice && <PSNotice status={notice.status} onRemove={() => setNotice(null)}>{notice.text}</PSNotice>}
      <div className="ps-conversation-form">
        <ConversationalField
          label="What local address should open this service?"
          description="Use a short name. Localhost Manager adds the selected local suffix and creates the HTTPS route."
        >
          <div className="ps-suffixfield">
          <input
            ref={domainNameInput}
            id="ingress-domain-name"
            aria-label="Domain name"
            placeholder="myapp"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(new RegExp(`\\.${tld}$`), ''))}
            onKeyDown={(e) => { if (e.key === 'Enter' && name && port) add(); }}
          />
            <span>.{tld}</span>
          </div>
        </ConversationalField>
        <details className="ps-field-options">
          <summary>Use another suffix</summary>
          <ConversationalField
            label="Which local suffix should this address use?"
            description="Keep .test unless this service needs one of your registered vanity suffixes."
          >
            <PopoverSelect
              className="ps-suffix-select"
              label="Local suffix"
              hideLabelFromVision
              value={tld}
              options={(tlds.data?.tlds?.map((item) => item.tld) || ['test']).map((item) => ({
                value: item,
                label: `.${item}`,
              }))}
              onChange={setTld}
              size="compact"
            />
          </ConversationalField>
        </details>
        <ConversationalField
          label="Which port is the service listening on?"
          description="Localhost Manager sends requests for this address to the service on 127.0.0.1 at this port."
        >
          <input
            className="ps-search ps-portinput"
            aria-label="Upstream port"
            placeholder="3000"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter' && name && port) add(); }}
          />
        </ConversationalField>
        <div className="ps-field-actions">
          <Button __next40pxDefaultSize variant="primary" isBusy={busy} disabled={!name || !port} onClick={add}>
            Add domain
          </Button>
        </div>
      </div>
      <div className="ps-subhead-row">
        <h3 className="ps-subhead ps-subhead--flush">Detected Docker web services</h3>
        <div className="ps-subhead-actions">
          {docker.data?.available && <Chip tone="success">{dockerRows.length} detected</Chip>}
          {docker.data?.available && <CopyForAI build={dockerBlock} what="the detected Docker web services" />}
        </div>
      </div>
      {docker.error && <PSNotice status="error" isDismissible={false}>{docker.error}</PSNotice>}
      {!docker.data && !docker.error && <Spinner />}
      {docker.data && !docker.data.available && (
        <PSNotice status="warning" isDismissible={false}>{docker.data.error}</PSNotice>
      )}
      {docker.data?.available && dockerRows.length === 0 && (
        <Text className="ps-hint">Docker is available, but no published TCP port responded as HTTP or HTTPS.</Text>
      )}
      {docker.data?.available && dockerRows.length > 0 && (
        <PSDataView
          data={dockerRows}
          fields={DOCKER_FIELDS}
          actions={[
            {
              id: 'register-domain',
              label: 'Register domain…',
              isEligible: (item) => item.ingressDomains.length === 0,
              callback: ([item]) => prefillDockerDomain(item),
            },
          ]}
          itemKey="id"
          aiWhat={AI_WHAT.docker}
          aiQuestion={AI_ROW_QUESTION.docker}
        />
      )}
      {docker.data?.available && (
        <Text className="ps-hint">
          Localhost Manager asks Docker for running containers, then probes published TCP ports. Database ports and internal-only containers stay out of this list. “All interfaces” means the service is exposed beyond localhost even before ingress.
        </Text>
      )}
      <div className="ps-subhead-row">
        <h3 className="ps-subhead ps-subhead--flush">Registered domains</h3>
        <CopyForAI build={registeredBlock} what="the registered domains" />
      </div>
      <PSDataView
        data={data.domains}
        fields={DOMAIN_FIELDS}
        actions={[
          {
            id: 'edit',
            label: 'Edit domain',
            callback: ([item]) => {
              const splitAt = item.host.lastIndexOf('.');
              setEdit({
                originalHost: item.host,
                name: item.host.slice(0, splitAt),
                tld: item.host.slice(splitAt + 1),
                port: String(item.port),
              });
            },
          },
          {
            id: 'routes',
            label: 'Extra routes…',
            callback: ([item]) => setRouteEdit({
              host: item.host,
              rows: (item.routes || []).length
                ? item.routes.map((r) => ({ path: r.path, port: String(r.port) }))
                : [{ path: '', port: '' }],
            }),
          },
          { id: 'service-link', label: 'Link service…', callback: ([item]) => setSvcEdit({ host: item.host, service: item.service || '' }) },
          { id: 'service-start', label: 'Start service', isEligible: (item) => !!item.service && !item.serviceState?.missing && !item.serviceState?.disabled && !item.serviceState?.running, callback: ([item]) => svcAction(item.service, 'start') },
          { id: 'service-stop', label: 'Stop service', isDestructive: true, isEligible: (item) => !!item.service && !!item.serviceState?.running, callback: ([item]) => svcAction(item.service, 'stop') },
          { id: 'remove', label: 'Remove', isDestructive: true, callback: ([item]) => setConfirmHost(item.host) },
        ]}
        itemKey="host"
        aiWhat={AI_WHAT.domains}
        aiQuestion={AI_ROW_QUESTION.domains}
      />
      {edit && (
        <div className="ps-conversation-form">
          <ConversationalField
            label="What should this local address be?"
            description="Changing the name replaces the current HTTPS route and cleans up its old local resolution entry."
          >
            <div className="ps-suffixfield">
            <input
              aria-label="Domain name"
              autoFocus
              value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value.toLowerCase().replace(new RegExp(`\\.${edit.tld}$`), '') })}
              onKeyDown={(e) => { if (e.key === 'Enter' && edit.name && edit.port) saveDomain(); if (e.key === 'Escape') setEdit(null); }}
            />
              <span>.{edit.tld}</span>
            </div>
          </ConversationalField>
          <details className="ps-field-options">
            <summary>Use another suffix</summary>
            <ConversationalField
              label="Which local suffix should this address use?"
              description="Changing the suffix moves the address to another registered local namespace."
            >
              <PopoverSelect
                className="ps-suffix-select"
                value={edit.tld}
                label="Local suffix"
                hideLabelFromVision
                options={[...new Set([...(tlds.data?.tlds?.map((item) => item.tld) || ['test']), edit.tld])].map((item) => ({
                  value: item,
                  label: `.${item}`,
                }))}
                onChange={(value) => setEdit({ ...edit, tld: value })}
                size="compact"
              />
            </ConversationalField>
          </details>
          <ConversationalField
            label="Which port should receive requests?"
            description="Use the port where the local service is already listening."
          >
            <input
              className="ps-search ps-portinput"
              aria-label="Upstream port"
              placeholder="3000"
              inputMode="numeric"
              value={edit.port}
              onChange={(e) => setEdit({ ...edit, port: e.target.value.replace(/\D/g, '') })}
              onKeyDown={(e) => { if (e.key === 'Enter' && edit.name && edit.port) saveDomain(); if (e.key === 'Escape') setEdit(null); }}
            />
          </ConversationalField>
          <div className="ps-field-actions">
            <Button __next40pxDefaultSize variant="primary" isBusy={busy} disabled={!edit.name || !edit.port} onClick={saveDomain}>Save domain</Button>
            <Button __next40pxDefaultSize variant="tertiary" onClick={() => setEdit(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {svcEdit && (
        <div className="ps-conversation-form">
          <p className="ps-field-context"><strong>{svcEdit.host}</strong> is the address being linked.</p>
          <ConversationalField
            label="Which launchd service starts this site?"
            description="Localhost Manager uses this link to show service health and offer the correct start or stop action beside the domain."
          >
            <PopoverSelect
              className="ps-suffix-select"
              label="Launchd service"
              hideLabelFromVision
              value={svcEdit.service}
              options={[
                { value: '', label: 'No linked service' },
                ...[...new Set([...(data.agents || []), ...(svcEdit.service ? [svcEdit.service] : [])])]
                  .sort()
                  .map((item) => ({ value: item, label: item })),
              ]}
              onChange={(value) => setSvcEdit({ ...svcEdit, service: value })}
            />
          </ConversationalField>
          <div className="ps-field-actions">
            <Button __next40pxDefaultSize variant="primary" isBusy={busy} onClick={saveService}>Save link</Button>
            <Button __next40pxDefaultSize variant="tertiary" onClick={() => setSvcEdit(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {routeEdit && (
        <div className="ps-conversation-form">
          <p className="ps-field-context"><strong>{routeEdit.host}</strong> is the address being split across ports.</p>
          <ConversationalField
            label="Which paths should go to a different port?"
            description="Most domains need none. Add one only when the app is really two services behind one address, like a UI on one port and its websocket on another. Anything not listed keeps going to the main upstream port."
          >
            <div className="ps-routerows">
              {routeEdit.rows.map((row, index) => (
                <div className="ps-routerow" key={index}>
                  <input
                    className="ps-search"
                    aria-label={`Path ${index + 1}`}
                    placeholder="/app/*"
                    value={row.path}
                    onChange={(e) => setRouteEdit({
                      ...routeEdit,
                      rows: routeEdit.rows.map((r, i) => (i === index ? { ...r, path: e.target.value } : r)),
                    })}
                  />
                  <span className="ps-routerow__arrow" aria-hidden="true">→</span>
                  <input
                    className="ps-search ps-portinput"
                    aria-label={`Port for path ${index + 1}`}
                    placeholder="6001"
                    inputMode="numeric"
                    value={row.port}
                    onChange={(e) => setRouteEdit({
                      ...routeEdit,
                      rows: routeEdit.rows.map((r, i) => (i === index ? { ...r, port: e.target.value.replace(/\D/g, '') } : r)),
                    })}
                  />
                  <Button
                    __next40pxDefaultSize
                    variant="tertiary"
                    isDestructive
                    aria-label={`Remove path ${index + 1}`}
                    onClick={() => setRouteEdit({
                      ...routeEdit,
                      rows: routeEdit.rows.length > 1
                        ? routeEdit.rows.filter((_, i) => i !== index)
                        : [{ path: '', port: '' }],
                    })}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </ConversationalField>
          <div className="ps-field-actions">
            <Button __next40pxDefaultSize variant="secondary" onClick={() => setRouteEdit({ ...routeEdit, rows: [...routeEdit.rows, { path: '', port: '' }] })}>
              Add another path
            </Button>
          </div>
          <div className="ps-field-actions">
            <Button __next40pxDefaultSize variant="primary" isBusy={busy} onClick={saveRoutes}>Save routes</Button>
            <Button __next40pxDefaultSize variant="tertiary" onClick={() => setRouteEdit(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {confirmHost && (
        <PSNotice status="warning" onRemove={() => setConfirmHost(null)} spokenMessage={`Remove ${confirmHost} — site block and cert?`}>
          Remove {confirmHost} (site block + cert)?{' '}
          <Button size="small" variant="primary" isDestructive onClick={() => remove(confirmHost)}>Remove it</Button>
        </PSNotice>
      )}
      <Text className="ps-hint">Domain and port changes apply live because the root daemon watches the user-owned config. With auto-apply on, new resolution lines and old-name cleanup follow automatically. Link a domain to one of your launchd agents and its upstream can be started and stopped right from this table.</Text>

      <div className="ps-subhead-row">
        <h3 className="ps-subhead ps-subhead--flush">Browser reach</h3>
        <div className="ps-subhead-actions">
          <Chip tone={!proxy.on ? 'success' : proxy.gaps.length ? 'error' : 'success'}>
            {!proxy.on ? 'no system proxy' : proxy.gaps.length ? `${proxy.gaps.length} suffix${proxy.gaps.length > 1 ? 'es' : ''} claimed` : 'all suffixes exempt'}
          </Chip>
        </div>
      </div>
      <div className="ps-proxyreach">
        <div className="ps-dnsrow">
          {proxy.on ? (
            <>
              {proxy.socks && <Chip tone="warning">SOCKS {proxy.server}</Chip>}
              {proxy.http && <Chip tone="warning">HTTP proxy</Chip>}
              {proxy.https && <Chip tone="warning">HTTPS proxy</Chip>}
              {proxy.pac && <Chip tone="warning">auto-config file</Chip>}
            </>
          ) : <Chip tone="success">proxy off</Chip>}
        </div>
        <ul className="ps-suffixlist">
          {proxy.suffixes.map((item) => (
            <li key={item.tld}>
              <span className="ps-mono">{item.entry}</span>
              {item.covered
                ? <Chip tone="success">exempt</Chip>
                : proxy.on ? <Chip tone="error">claimed by the proxy</Chip> : <Chip>not exempt</Chip>}
            </li>
          ))}
        </ul>
        {proxy.gaps.length > 0 && (
          <div className="ps-field-actions">
            <Button __next40pxDefaultSize variant="primary" isBusy={proxyBusy} onClick={fixBypass}>
              Exempt these suffixes from the proxy
            </Button>
          </div>
        )}
        <Text className="ps-hint">
          A system proxy resolves hostnames on its own side, where a name that exists only on this machine cannot
          exist, so it answers before the hosts file or any resolver is consulted. The bypass list is the exemption and
          it works by suffix, so one entry per registered TLD covers every site under it, including ones added later.
          {proxy.pac && ' An auto-config file is also in play; it can route a name even when the bypass list exempts it.'}
          {' '}Localhost Manager only adds entries here. Nothing another tool put in the list is removed, and a suffix’s entry
          is retired only when you deregister that TLD.
        </Text>
      </div>

      <div className="ps-subhead-row">
        <h3 className="ps-subhead ps-subhead--flush">All observed local domains</h3>
        <CopyForAI build={observedBlock} what="every observed local domain" />
      </div>
      {stagedEdits.length > 0 && (
        <PSNotice
          status="warning"
          isDismissible={false}
          spokenMessage={data.autoApply
            ? `${stagedEdits.length} privileged-file edit${stagedEdits.length > 1 ? 's are' : ' is'} queued for automatic apply.`
            : `${stagedEdits.length} staged edit${stagedEdits.length > 1 ? 's' : ''} to privileged files. Apply once with sudo.`}
        >
          {data.autoApply
            ? `${stagedEdits.length} validated edit${stagedEdits.length > 1 ? 's are' : ' is'} queued for the root worker.`
            : <SudoSteps intro={`${stagedEdits.length} staged edit${stagedEdits.length > 1 ? 's' : ''} to privileged files (hosts / dnsmasq / resolver). Apply once with sudo.`} command={staged.data.applyCommand} />}
          <ul className="ps-editlist">
            {stagedEdits.map((e) => (
              <li key={e.id}>
                <code>{describeEdit(e)}</code>
                {!data.autoApply && <Button size="small" variant="tertiary" onClick={() => unstage(e.id)}>Cancel</Button>}
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
            <div className="ps-conversation-form">
              <p className="ps-field-context"><strong>{ipEdit.kind === 'dnsmasq-set' ? ipEdit.key : ipEdit.name}</strong> is the local name being changed.</p>
              <ConversationalField
                label="What IP address should this name resolve to?"
                description="Requests for this name will be sent to this address after the validated hosts or dnsmasq edit is applied."
              >
                <input
                  className="ps-search"
                  aria-label="IP address"
                  autoFocus
                  placeholder="127.0.0.1"
                  value={ipEdit.ip}
                  onChange={(e) => setIpEdit({ ...ipEdit, ip: e.target.value.trim() })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && ipEdit.ip) { stage(ipEdit.kind === 'dnsmasq-set' ? { kind: ipEdit.kind, key: ipEdit.key, ip: ipEdit.ip } : { kind: ipEdit.kind, name: ipEdit.name, ip: ipEdit.ip }); setIpEdit(null); }
                    if (e.key === 'Escape') setIpEdit(null);
                  }}
                />
              </ConversationalField>
              <div className="ps-field-actions">
                <Button
                  __next40pxDefaultSize
                  variant="primary"
                  disabled={!ipEdit.ip}
                  onClick={() => { stage(ipEdit.kind === 'dnsmasq-set' ? { kind: ipEdit.kind, key: ipEdit.key, ip: ipEdit.ip } : { kind: ipEdit.kind, name: ipEdit.name, ip: ipEdit.ip }); setIpEdit(null); }}
                >
                  {data.autoApply ? 'Apply edit' : 'Stage edit'}
                </Button>
                <Button __next40pxDefaultSize variant="tertiary" onClick={() => setIpEdit(null)}>Cancel</Button>
              </div>
            </div>
          )}
          {resEdit && (
            <div className="ps-log ps-editor">
              <div className="ps-log__head">
                <span className="ps-mono">/etc/resolver/{resEdit.file}</span>
                <span>
                  <Button size="small" variant="primary" disabled={!resEdit.content.trim()} onClick={() => { stage({ kind: 'resolver-write', file: resEdit.file, content: resEdit.content }); setResEdit(null); }}>{data.autoApply ? 'Apply edit' : 'Stage edit'}</Button>
                  <Button size="small" variant="tertiary" onClick={() => setResEdit(null)}>Close</Button>
                </span>
              </div>
              <ConversationalField
                className="ps-expert-field"
                label="Resolver file contents"
                description="This expert setting routes the whole suffix to a nameserver. The save action validates and queues the root-owned file change before it is applied."
              >
                <textarea
                  className="ps-editor__area ps-editor__area--short"
                  aria-label="Resolver file contents"
                  spellCheck={false}
                  value={resEdit.content}
                  onChange={(e) => setResEdit({ ...resEdit, content: e.target.value })}
                />
              </ConversationalField>
            </div>
          )}
          <Text className="ps-hint">Everything the machine declares (hosts file, dnsmasq, resolver files), including domains other tools own. Root-owned files are changed through a validated queue; auto-apply writes backups, restarts dnsmasq, and flushes caches. "Divergent" means the system resolver and dnsmasq disagree. Rows marked <em>managed</em> belong to the registry at the top; edit them there.</Text>
        </>
      )}
    </Section>
  );
}

function Activity() {
  const { data, error, reload } = useApi('activity');
  const ready = data?.retentionDays === 30 && data?.workerVersion === 2;
  const sectionPrompt = () => aiPrompt({
    subject: 'Below is Localhost Manager’s auto-apply activity log. It records validated DNS, hosts, and resolver queue processing by the root worker.',
    body: [
      `Worker version: ${data?.workerVersion || 'not installed'}`,
      `Retention: ${data?.retentionDays ? `${data.retentionDays} days` : 'not configured'}`,
      `Interrupted queue claims: ${data?.orphanedClaims || 0}`,
      `Log: ${data?.logPath || 'unavailable'}`,
      '',
      ...(data?.lines || ['No activity recorded yet.']),
    ].join('\n'),
    question: 'Explain what changed, call out failures, rejected edits, interrupted runs, or suspicious gaps, and tell me whether the worker looks healthy now.',
  });
  return (
    <Section
      title="Activity"
      className="ps-section--activity"
      actions={
        <>
          {data && <CopyForAI build={sectionPrompt} what="the activity log" />}
          <Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>
        </>
      }
    >
      {error && <PSNotice status="error" isDismissible={false}>{error}</PSNotice>}
      {!data && !error && <Spinner />}
      {data && (
        <>
          <div className="ps-dnsrow">
            <Chip tone={data.workerVersion === 2 ? 'success' : 'warning'}>
              {data.workerVersion ? `auto-apply worker v${data.workerVersion}` : 'worker not installed'}
            </Chip>
            <Chip tone={ready ? 'success' : 'warning'}>
              {data.retentionDays ? `${data.retentionDays}-day retention` : 'retention not configured'}
            </Chip>
            {data.orphanedClaims > 0 && <Chip tone="warning">{data.orphanedClaims} interrupted claim{data.orphanedClaims > 1 ? 's' : ''}</Chip>}
          </div>
          {!ready && (
            <PSNotice
              status="warning"
              isDismissible={false}
              spokenMessage="The stable auto-apply worker and 30-day activity retention need the installer upgrade."
            >
              <SudoSteps
                intro={`Re-run the one-time installer to replace the worker, enable 30-day activity retention${data.orphanedClaims ? `, and recover ${data.orphanedClaims} interrupted queue claim${data.orphanedClaims > 1 ? 's' : ''}` : ''}.`}
                command={data.installCommand}
              />
            </PSNotice>
          )}
          <div className="ps-log">
            <div className="ps-log__head">
              <span>Auto-apply activity</span>
              <span className="ps-mono">{data.logPath}</span>
            </div>
            <pre>{data.lines.join('\n') || 'No activity recorded yet.'}</pre>
          </div>
          <Text className="ps-hint">The root worker records queued changes, validation results, failures, and successful applies here. An idle heartbeat appears daily, and macOS rotates the log with 30-day retention.</Text>
        </>
      )}
    </Section>
  );
}

// Vanity TLDs: the set of custom suffixes the ingress serves beside .test.
// Registering one is a registry write plus, if the /etc/resolver/<tld> file
// isn't already there, one staged privileged edit — applied by the same
// apply-edits.sh run as every other observed-domain edit. Sites under a TLD
// are added on the Ingress screen (the TLD becomes a suffix in the dropdown).
function Tlds() {
  const { data, error, reload } = useApi('tlds');
  const staged = useApi('observed/edits');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirm, setConfirm] = useState(null);
  if (error) return <PSNotice status="error" isDismissible={false}>{error}</PSNotice>;
  if (!data) return <Spinner />;
  const refreshAll = () => { reload(); staged.reload(); };
  const refreshAfterApply = () => {
    refreshAll();
    if (data.autoApply) {
      setTimeout(refreshAll, 900);
      setTimeout(refreshAll, 2600);
      setTimeout(refreshAll, 5000);
    }
  };
  const add = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch('/api/tlds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tld: label }),
      }).then(async (x) => { const b = await x.json(); if (!x.ok) throw new Error(b.error); return b; });
      setNotice({
        status: 'success',
        text: r.staged
          ? data.autoApply
            ? `.${r.tld} registered. Its resolver file is applying automatically.`
            : `.${r.tld} registered. Apply the staged resolver file below, then it is ready for sites.`
          : `.${r.tld} registered. Its resolver file was already in place, so it is ready now.`,
      });
      setLabel('');
      refreshAfterApply();
    } catch (e) {
      setNotice({ status: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (tld) => {
    setConfirm(null);
    const r = await fetch(`/api/tlds/${encodeURIComponent(tld)}`, { method: 'DELETE' })
      .then(async (x) => { const b = await x.json(); if (!x.ok) throw new Error(b.error); return b; })
      .catch((e) => ({ error: e.message }));
    if (r.error) setNotice({ status: 'error', text: r.error });
    refreshAfterApply();
  };
  const unstage = async (id) => {
    await fetch(`/api/observed/edits/${id}`, { method: 'DELETE' });
    refreshAll();
  };
  const resolverEdits = (staged.data?.edits || []).filter((e) => e.kind === 'resolver-write' || e.kind === 'resolver-del');
  const describeEdit = (e) => (e.kind === 'resolver-write' ? `resolver: write /etc/resolver/${e.file}` : `resolver: remove /etc/resolver/${e.file}`);
  const sectionPrompt = () => aiPrompt({
    subject: `Below, from Localhost Manager: ${AI_WHAT.tlds}.`,
    body: aiTable(TLD_FIELDS, data.tlds),
    question: AI_SECTION_QUESTION,
  });
  return (
    <Section
      title="Vanity TLDs"
      actions={
        <>
          <CopyForAI build={sectionPrompt} what="the registered TLDs" label="Copy screen for AI" />
          <Button __next40pxDefaultSize variant="secondary" onClick={refreshAll}>Refresh</Button>
        </>
      }
    >
      <div className="ps-dnsrow">
        <Chip tone={data.autoApply ? 'success' : 'warning'}>
          {data.autoApply ? 'auto-apply on' : 'auto-apply off'}
        </Chip>
      </div>
      {!data.autoApply && (
        <PSNotice
          status="warning"
          isDismissible={false}
          spokenMessage="Automatic resolver updates are not installed. One privileged install enables them."
        >
          <SudoSteps intro="One privileged install enables validated automatic resolver updates. No password or Keychain environment variable is stored." command={data.installCommand} />
        </PSNotice>
      )}
      {notice && <PSNotice status={notice.status} onRemove={() => setNotice(null)}>{notice.text}</PSNotice>}
      {resolverEdits.length > 0 && (
        <PSNotice
          status="warning"
          isDismissible={false}
          spokenMessage={data.autoApply
            ? `${resolverEdits.length} resolver edit${resolverEdits.length > 1 ? 's are' : ' is'} queued for automatic apply.`
            : `${resolverEdits.length} resolver file${resolverEdits.length > 1 ? 's' : ''} staged. Apply once with sudo.`}
        >
          {data.autoApply
            ? `${resolverEdits.length} resolver edit${resolverEdits.length > 1 ? 's are' : ' is'} queued for the root worker.`
            : <SudoSteps intro={`${resolverEdits.length} resolver file${resolverEdits.length > 1 ? 's' : ''} staged (/etc/resolver). Apply once with sudo to route the suffix to the local resolver.`} command={data.applyCommand} />}
          <ul className="ps-editlist">
            {resolverEdits.map((e) => (
              <li key={e.id}>
                <code>{describeEdit(e)}</code>
                {!data.autoApply && <Button size="small" variant="tertiary" onClick={() => unstage(e.id)}>Cancel</Button>}
              </li>
            ))}
          </ul>
        </PSNotice>
      )}
      <div className="ps-conversation-form">
        <ConversationalField
          label="Which vanity suffix should this Mac resolve?"
          description="Localhost Manager registers this suffix and prepares its resolver file. Use .test when a custom local namespace is not required."
        >
          <div className="ps-suffixfield">
            <span>.</span>
            <input
              aria-label="Vanity suffix"
              placeholder="example"
              value={label}
              onChange={(e) => setLabel(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter' && label) add(); }}
            />
          </div>
        </ConversationalField>
        <div className="ps-field-actions">
          <Button __next40pxDefaultSize variant="primary" isBusy={busy} disabled={!label} onClick={add}>
            Add TLD
          </Button>
        </div>
      </div>
      <PSDataView
        data={data.tlds}
        fields={TLD_FIELDS}
        actions={[
          {
            id: 'remove',
            label: 'Remove',
            isDestructive: true,
            isEligible: (item) => !item.builtin && item.sites === 0,
            callback: ([item]) => setConfirm(item.tld),
          },
        ]}
        itemKey="tld"
        aiWhat={AI_WHAT.tlds}
        aiQuestion={AI_ROW_QUESTION.tlds}
      />
      {confirm && (
        <PSNotice status="warning" onRemove={() => setConfirm(null)} spokenMessage={`Remove the .${confirm} TLD?`}>
          Remove the <span className="ps-mono">.{confirm}</span> TLD (deregisters the suffix and queues removal of its resolver file)?{' '}
          <Button size="small" variant="primary" isDestructive onClick={() => remove(confirm)}>Remove it</Button>
        </PSNotice>
      )}
      <Text className="ps-hint">
        .test is builtin and always available. A vanity TLD adds an <span className="ps-mono">/etc/resolver/&lt;tld&gt;</span> file that routes the whole suffix to the local resolver. Auto-apply installs or removes it through the validated root queue. Add sites under it from <strong>Ingress &amp; Domains</strong>, where every registered TLD shows in the suffix dropdown. Removing a TLD needs its sites gone first. Vanity suffixes resolve only on this Mac; .test is the RFC-reserved, zero-risk choice.
      </Text>
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
    subject: `Below, from Localhost Manager: ${AI_WHAT.ports}.`,
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
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [draft, setDraft] = useState(NEW_AGENT);
  if (error) return <PSNotice status="error" isDismissible={false}>{error}</PSNotice>;
  if (!data) return <Spinner />;
  // Disabled agents (plist parked under a .disabled suffix) list too, so they
  // can be re-enabled from here. Keyed by file: a parked copy can coexist
  // with a live plist carrying the same label.
  const rows = data.filter((j) => j.owned).map((j) => ({ ...j, _k: j.file }));
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
  // Lifecycle: start/stop load and unload the agent now; disable/enable park
  // and unpark its plist (a .disabled suffix) so login skips or runs it.
  const lifecycle = async (label, verb) => {
    const r = await fetch(`/api/launchd/${encodeURIComponent(label)}/${verb}`, { method: 'POST' }).then((x) => x.json());
    setNotice(r.ok
      ? { status: 'success', text: `${label}: ${verb} done.${r.note ? ` ${r.note}` : ''}` }
      : { status: 'error', text: r.error || 'Failed.' });
    setTimeout(reload, 700);
  };
  // Create: the server validates the spec, lints the generated plist, and only
  // then writes it. A load failure still leaves the plist, so it can be fixed
  // in the editor rather than silently rolled back.
  const createAgent = async () => {
    setBusy(true);
    const r = await fetch('/api/launchd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(agentSpecFromDraft(draft)),
    }).then((x) => x.json());
    setBusy(false);
    if (r.error) return setNotice({ status: 'error', text: r.error });
    setNotice({
      status: r.loaded ? 'success' : 'warning',
      text: r.loaded
        ? `${r.label} created and loaded. Logs: ${r.stdoutPath}`
        : `${r.label} written to ${r.file}, but launchctl refused it: ${r.loadError}. Fix it with Edit plist, then Start.`,
    });
    setDraft(NEW_AGENT);
    setAdding(false);
    setTimeout(reload, 700);
  };
  const removeAgent = async (label) => {
    setConfirmRemove(null);
    const r = await fetch(`/api/launchd/${encodeURIComponent(label)}`, { method: 'DELETE' }).then((x) => x.json());
    setNotice(r.ok
      ? { status: 'success', text: `${label} removed. Its logs were kept.` }
      : { status: 'error', text: r.error || 'Failed.' });
    setTimeout(reload, 700);
  };
  const actions = [
    { id: 'start', label: 'Start', callback: ([item]) => lifecycle(item.label, 'start'), isEligible: (item) => item.domain === 'user' && !item.disabled && !item.running },
    { id: 'stop', label: 'Stop', isDestructive: true, callback: ([item]) => lifecycle(item.label, 'stop'), isEligible: (item) => item.domain === 'user' && !!item.running },
    { id: 'enable', label: 'Enable', callback: ([item]) => lifecycle(item.label, 'enable'), isEligible: (item) => item.domain === 'user' && item.disabled },
    { id: 'disable', label: 'Disable', isDestructive: true, callback: ([item]) => lifecycle(item.label, 'disable'), isEligible: (item) => item.domain === 'user' && !item.disabled },
    { id: 'log', label: 'Log', callback: ([item]) => showFile(item.label, 'log'), isEligible: (item) => !!item.log },
    { id: 'edit', label: 'Edit plist', callback: ([item]) => openEditor(item.label), isEligible: (item) => item.domain === 'user' },
    { id: 'plist', label: 'View plist', callback: ([item]) => showFile(item.label, 'plist'), isEligible: (item) => item.domain !== 'user' },
    { id: 'kickstart', label: 'Kickstart', callback: ([item]) => kick(item.label), isEligible: (item) => item.domain === 'user' && !item.disabled },
    { id: 'remove', label: 'Remove', isDestructive: true, callback: ([item]) => setConfirmRemove(item.label), isEligible: (item) => item.domain === 'user' },
  ];
  const sectionPrompt = () => aiPrompt({
    subject: `Below, from Localhost Manager: ${AI_WHAT.services}.`,
    body: aiTable(SERVICE_FIELDS, rows),
    question: AI_SECTION_QUESTION,
  });
  return (
    <Section
      title="Launchd services (yours)"
      actions={
        <>
          <CopyForAI build={sectionPrompt} what="every launchd agent you own" />
          <Button __next40pxDefaultSize variant={adding ? 'secondary' : 'primary'} onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add agent'}
          </Button>
          <Button __next40pxDefaultSize variant="secondary" onClick={reload}>Refresh</Button>
        </>
      }
    >
      {notice && <PSNotice status={notice.status} onRemove={() => setNotice(null)}>{notice.text}</PSNotice>}
      {confirmRemove && (
        <PSNotice status="warning" onRemove={() => setConfirmRemove(null)} spokenMessage={`Remove ${confirmRemove}?`}>
          Remove <span className="ps-mono">{confirmRemove}</span>? This unloads it and deletes its plist. Its logs are kept.{' '}
          <Button size="small" variant="primary" isDestructive onClick={() => removeAgent(confirmRemove)}>Remove it</Button>
        </PSNotice>
      )}
      {adding && (
        <div className="ps-conversation-form">
          <ConversationalField
            label="What should this agent be called?"
            description="Labels must start with am.danielk., com.danielkam. or dev.1dr0. Localhost Manager only manages agents it owns."
          >
            <input
              aria-label="Label"
              placeholder="am.danielk.my-service"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value.trim() })}
            />
          </ConversationalField>
          <ConversationalField
            label="What should it run?"
            description="An absolute path, then its arguments. launchd has no PATH of its own, so a bare command name will not resolve."
          >
            <input
              aria-label="Command"
              placeholder="/opt/homebrew/bin/node /Users/you/app/server.js --port 4000"
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
          </ConversationalField>
          <ConversationalField
            label="Where should it run, and with what environment?"
            description="Working directory is optional. Environment is one KEY=VALUE per line; anything the process needs on PATH belongs here."
          >
            <input
              aria-label="Working directory"
              placeholder="/Users/you/app"
              value={draft.cwd}
              onChange={(e) => setDraft({ ...draft, cwd: e.target.value.trim() })}
            />
            <textarea
              aria-label="Environment variables"
              rows={3}
              placeholder={'PATH=/opt/homebrew/bin:/usr/bin:/bin\nNODE_ENV=production'}
              value={draft.env}
              onChange={(e) => setDraft({ ...draft, env: e.target.value })}
            />
          </ConversationalField>
          <ConversationalField
            label="When should it run?"
            description="Keep alive restarts it whenever it stops. Crash only restarts it after a non-zero exit. At login runs it once when you log in."
          >
            <PopoverSelect
              label="Restart policy"
              hideLabelFromVision
              value={draft.keepAlive}
              options={[
                { value: 'always', label: 'Keep alive, always' },
                { value: 'crash-only', label: 'Restart only after a crash' },
                { value: 'never', label: 'Do not restart' },
              ]}
              onChange={(value) => setDraft({ ...draft, keepAlive: value })}
              size="compact"
            />
            <label className="ps-checkline">
              <input
                type="checkbox"
                checked={draft.runAtLoad}
                onChange={(e) => setDraft({ ...draft, runAtLoad: e.target.checked })}
              />
              Start it at login
            </label>
          </ConversationalField>
          <div className="ps-field-actions">
            <Button
              __next40pxDefaultSize
              variant="primary"
              isBusy={busy}
              disabled={!draft.label || !draft.command.trim()}
              onClick={createAgent}
            >
              Create and load
            </Button>
          </div>
        </div>
      )}
      <PSDataView
        data={rows}
        fields={SERVICE_FIELDS}
        actions={actions}
        itemKey="_k"
        aiWhat={AI_WHAT.services}
        aiQuestion={AI_ROW_QUESTION.services}
      />
      <Text className="ps-hint">Start and Stop load and unload an agent now. Disable parks its plist under a <span className="ps-mono">.disabled</span> suffix so login skips it; Enable unparks and loads it again. System daemons stay read-only here.</Text>
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
          <ConversationalField
            className="ps-expert-field"
            label="Launchd service definition"
            description="This expert setting controls how macOS starts the service. Save validates the plist and replaces its file. Kickstart remains a separate action."
          >
            <textarea
              className="ps-editor__area"
              aria-label="Launchd service definition"
              spellCheck={false}
              value={editor.text}
              onChange={(e) => setEditor({ ...editor, text: e.target.value, dirty: true })}
            />
          </ConversationalField>
        </div>
      )}
    </Section>
  );
}

function RemoteServices() {
  const inventory = useApi('providers/dk-sin1/services');
  const audit = useApi('providers/dk-sin1/audit');
  const notify = useNotify();
  if (inventory.error) return <PSNotice status="error" isDismissible={false}>{inventory.error}</PSNotice>;
  if (!inventory.data) return <Spinner />;
  const lifecycle = async (item, action) => {
    if (['stop', 'restart'].includes(action) && !window.confirm(`${action} ${item.projectId}/${item.name} on dk-sin1?`)) return;
    const response = await fetch('/api/providers/dk-sin1/services/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, project: item.projectId, service: item.name }),
    });
    const result = await response.json();
    if (!response.ok || result.error) {
      notify(result.error || 'Remote provider action failed.', 'error');
      return;
    }
    notify(`${item.projectId}/${item.name}: ${action} completed.`);
    inventory.reload();
    audit.reload();
  };
  const rows = inventory.data.projects.flatMap((project) => project.services.map((service) => {
    const row = {
      ...service,
      _k: `${project.id}/${service.name}`,
      projectId: project.id,
      containerProject: project.project,
      route: project.route,
    };
    row.runAction = (action) => lifecycle(row, action);
    return row;
  }));
  const actions = [
    { id: 'start', label: 'Start', callback: ([item]) => lifecycle(item, 'start'), isEligible: (item) => item.actions.includes('start') && item.state !== 'running' },
    { id: 'stop', label: 'Stop', isDestructive: true, callback: ([item]) => lifecycle(item, 'stop'), isEligible: (item) => item.actions.includes('stop') && item.state === 'running' },
    { id: 'restart', label: 'Restart', callback: ([item]) => lifecycle(item, 'restart'), isEligible: (item) => item.actions.includes('restart') },
    { id: 'pull', label: 'Pull image', callback: ([item]) => lifecycle(item, 'pull'), isEligible: (item) => item.actions.includes('pull') },
  ];
  const sectionPrompt = () => aiPrompt({
    subject: `Below, from Localhost Manager: ${AI_WHAT.remote}.`,
    body: aiTable(REMOTE_SERVICE_FIELDS, rows),
    question: AI_SECTION_QUESTION,
  });
  const auditLines = (audit.data?.records || []).slice(-20).map((record) => (
    `${record.timestamp} ${record.actor} ${record.action} ${record.target} ${record.result}`
  ));
  return (
    <Section
      title="Remote services on dk-sin1"
      actions={
        <>
          <CopyForAI build={sectionPrompt} what="the dk-sin1 service inventory" />
          <Button __next40pxDefaultSize variant="secondary" onClick={() => { inventory.reload(); audit.reload(); }}>Refresh</Button>
        </>
      }
    >
      <div className="ps-dnsrow">
        <Chip tone="success">forced-command SSH connected</Chip>
        <Chip>{rows.length} allowlisted services</Chip>
        <Chip>{inventory.data.generatedAt}</Chip>
      </div>
      <PSDataView
        data={rows}
        fields={REMOTE_SERVICE_FIELDS}
        actions={actions}
        itemKey="_k"
        aiWhat={AI_WHAT.remote}
        aiQuestion={AI_ROW_QUESTION.remote}
      />
      <Text className="ps-hint">Services are read-only unless their manifest and the local Localhost Manager allowlist both grant a specific action. Coolify-managed projects are excluded.</Text>
      <div className="ps-log">
        <div className="ps-log__head"><span>Provider audit</span></div>
        <pre>{audit.error ? 'Audit unavailable.' : auditLines.join('\n') || '(no lifecycle actions recorded)'}</pre>
      </div>
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
    subject: `Below, from Localhost Manager: the DNS chain on this machine, and ${AI_WHAT.dns}.`,
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

// Every screen owns its permalink (house rule): /ingress, /activity, /ports,
// /services, /dns — the server SPA-falls-back all GETs to index.html. /domains was
// absorbed into /ingress; the old slug keeps working.
const SLUG_ALIASES = { domains: 'ingress' };
function usePath() {
  const valid = [...NAV.map((n) => n.id), 'help', 'settings', 'profile'];
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

function useNarrowScreen() {
  const query = '(max-width: 760px)';
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setIsNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return isNarrow;
}

let noticeId = 0;

export default function App() {
  const [page, setPage] = usePath();
  const [themePref, setThemePref] = useTheme();
  const [notices, setNotices] = useState([]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [tipDismissed, setTipDismissed] = useState(() => localStorage.getItem(TIP_KEY) === '1');
  const isNarrow = useNarrowScreen();
  const readiness = useApi('overview');
  useEffect(() => {
    const favicon = document.querySelector('link[rel="icon"]');
    if (favicon) favicon.href = DOCKMASTER_MARK;
  }, []);
  const Page = { overview: Overview, ingress: Ingress, activity: Activity, tlds: Tlds, ports: Ports, services: Services, remote: RemoteServices, dns: Dns, help: HelpPage, settings: SettingsPage, profile: ProfilePage }[page];
  const pageMeta = PAGE_META[page] || PAGE_META.overview;
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');
  const [sidebarWidth, setSidebarWidthState] = useState(readSidebarWidth);
  const setSidebarCollapsed = useCallback((v) => {
    setSidebarCollapsedState(v);
    localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0');
  }, []);
  const setSidebarWidth = useCallback((value) => {
    const next = boundSidebarWidth(value);
    setSidebarWidthState(next);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  }, []);
  const navigate = useCallback((id) => {
    setPage(id);
    setMobileNavOpen(false);
  }, [setPage]);
  const openProfile = useCallback(() => navigate('profile'), [navigate]);
  const closeProfile = useCallback(() => navigate('overview'), [navigate]);
  const dismissTip = useCallback(() => {
    setTipDismissed(true);
    localStorage.setItem(TIP_KEY, '1');
  }, []);
  const dismiss = useCallback((id) => setNotices((n) => n.filter((x) => x.id !== id)), []);
  const notify = useCallback((content, status = 'success') => {
    const id = String(++noticeId);
    setNotices((n) => [...n, { id, content, status, spokenMessage: content }]);
    if (status === 'success') setTimeout(() => dismiss(id), 4000);
  }, [dismiss]);
  return (
    <NotifyContext.Provider value={notify}>
    <div
      className={`ps-app${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${mobileNavOpen ? ' is-mobile-nav-open' : ''}`}
      data-app-style="waypoint"
      style={{ '--ps-sidebar-width': `${sidebarWidth}px` }}
    >
      <a className="ps-skip-link" href="#dockmaster-main">Skip to main content</a>
      <button className="ps-sidebar-backdrop" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />
      <aside
        className="ps-sidebar"
        aria-label="Localhost Manager navigation"
        aria-hidden={isNarrow && !mobileNavOpen ? 'true' : undefined}
        {...(isNarrow && !mobileNavOpen ? { inert: '' } : {})}
      >
        <AiChatResizeHandle
          className="ps-sidebar__resize left-panel-resize-handle"
          value={sidebarWidth}
          min={SIDEBAR_WIDTH_MIN}
          max={SIDEBAR_WIDTH_MAX}
          onValueChange={setSidebarWidth}
          step={16}
          edge="right"
          label="Resize Localhost Manager sidebar"
        />
        <header className="ps-sidebar__header">
          <Button
            className="ps-sidebar-collapse"
            icon={sidebarCollapsed ? menu : chevronLeft}
            label={isNarrow ? 'Close navigation' : sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            showTooltip
            onClick={() => isNarrow ? setMobileNavOpen(false) : setSidebarCollapsed(!sidebarCollapsed)}
          />
          <a href="/" className="ps-brand" aria-label="Go to Localhost Manager overview" onClick={(event) => { event.preventDefault(); navigate('overview'); }}>
            <img className="ps-brand__mark wpds-identity-image is-mark" src={DOCKMASTER_MARK} alt="" />
            <span className="ps-brand__copy"><strong>Localhost Manager</strong><span className="ps-brand__sub">local dev infrastructure</span></span>
          </a>
        </header>
        <div className="ps-sidebar__body">
          <p className="ps-sidebar__caption">Infrastructure</p>
          <nav className="ps-nav" aria-label="Main navigation">
            {NAV.map((n) => (
              <button key={n.id} title={sidebarCollapsed ? n.label : undefined} className={page === n.id ? 'is-active' : ''} aria-current={page === n.id ? 'page' : undefined} onClick={() => navigate(n.id)}><Icon icon={NAV_ICONS[n.id]} size={18} /><span className="ps-nav__label">{n.label}</span></button>
            ))}
          </nav>
          <div className="ps-sidebar__utilities">
            <Button className="ps-utility ps-utility--ask" icon={commentContent} isPressed={assistantOpen} onClick={() => { setAssistantOpen((open) => !open); setMobileNavOpen(false); }}><span className="ps-utility__label">Ask Localhost Manager</span></Button>
            <Button className={`ps-utility${page === 'help' ? ' is-active' : ''}`} icon={help} onClick={() => navigate('help')}><span className="ps-utility__label">Help &amp; Feedback</span></Button>
            <Button className={`ps-utility${page === 'settings' ? ' is-active' : ''}`} icon={cog} onClick={() => navigate('settings')}><span className="ps-utility__label">App settings</span></Button>
          </div>
          {!tipDismissed && (
            <aside className="ps-tip">
              <div className="ps-tip__head"><p className="ps-eyebrow">AI-powered tip</p><Button size="small" variant="tertiary" onClick={dismissTip}>Dismiss</Button></div>
              <strong>Trace before you change</strong>
              <p>Follow domain → listener → service to find the narrowest control that owns the symptom.</p>
            </aside>
          )}
          <details className="ps-insights">
            <summary>Control boundary</summary>
            <p>Localhost Manager separates read-only inspection, user-owned controls, and privileged system changes.</p>
          </details>
        </div>
        <footer className="ps-sidebar__footer">
          <FooterProfile onOpen={openProfile} />
          <AppearanceShortcut pref={themePref} onOpen={() => navigate('settings')} />
          <div className="ps-app-meta"><strong>Localhost Manager</strong><span>Version {VERSION}</span></div>
        </footer>
      </aside>
      <div className="ps-main-column">
        <header className="ps-topbar">
          <Button className="ps-mobile-menu" icon={menu} label="Open navigation" showTooltip onClick={() => { setAssistantOpen(false); setMobileNavOpen(true); }} />
          <div className="ps-topbar__title"><p className="ps-eyebrow">{pageMeta.eyebrow}</p><h1>{pageMeta.title}</h1></div>
          <div className="ps-topbar__actions">
            <span className={`ps-readiness${readiness.error ? ' is-error' : readiness.data ? ' is-ready' : ''}`}><span aria-hidden="true" />{readiness.error ? 'Needs attention' : readiness.data ? 'Local checks ready' : 'Checking local state'}</span>
            <Button __next40pxDefaultSize variant="primary" onClick={() => navigate('ingress')}>Register domain</Button>
          </div>
        </header>
        <main id="dockmaster-main" className="ps-main" tabIndex="-1">
          <Page go={navigate} themePref={themePref} onThemeChange={setThemePref} onDone={closeProfile} />
        </main>
      </div>
      {assistantOpen && (
        <>
          <button className="ps-assistant-backdrop" type="button" aria-label="Close Localhost Manager Assistant" onClick={() => setAssistantOpen(false)} />
          <AssistantPanel
            page={page}
            appearance={themePref}
            onNavigate={navigate}
            onClose={() => setAssistantOpen(false)}
          />
        </>
      )}
      <div className="ps-notices">
        <SnackbarList notices={notices} onRemove={dismiss} />
      </div>
    </div>
    </NotifyContext.Provider>
  );
}
