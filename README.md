# Localhost Manager

The local dev infrastructure control plane for one Mac: every listening
port and who owns it, every local domain and what it *actually* resolves
to, your launchd services with create/remove/editing/kickstart/log tail, the DNS chain
in the order it really answers — and the portless `*.test` ingress
manager (registry → Caddy site blocks → mkcert certs) absorbed from the
old Local Ingress tool.

Born from a debugging session where `snippets.test` returned NXDOMAIN while
dnsmasq, scoped resolvers, a root Caddy, Studio's wildcard binds, and
NextDNS were all simultaneously "correct." An interface that shows the
collisions — and can fix them — beats re-deriving them in a terminal every
time.

The footer's Local operator row is now the shared editable profile control.
Display name and avatar choices persist only in Localhost Manager's browser scope;
they do not change macOS, launchd, Docker, DNS, or privileged operator identity.
The row fills the footer and opens `/profile` as ordinary page content, not a
modal, dialog, drawer, or popover.

## Views

- **Overview** — a rotating, fixed-height orientation hero followed by three
  stacked Quick Start journeys and the live machine snapshot. Reduced-motion
  mode keeps the first hero variant. The journeys lead into domain setup, port
  investigation, and service recovery without replacing the underlying tools.
- **Ingress & Domains** — the one screen that views AND manages domains.
  A Docker discovery table asks the local engine for running containers,
  deduplicates Docker Desktop's IPv4/IPv6 port bindings, and probes published
  TCP ports for HTTP or HTTPS. Web services show their Compose project,
  container health, port mapping, and any domain already proxying that port.
  **Register domain…** prefills the existing add-domain form; internal-only
  containers and non-web ports such as Postgres and Redis stay out of the
  ingress candidates.
  Managed domains live in the registry (`~/.local/share/local-ingress/`):
  add a bare name under `.test` or a vanity TLD, edit its hostname, suffix,
  and upstream port, or remove. Caddy changes apply live, while the installed
  auto-apply job consumes validated DNS/hosts cleanup queues without another
  password prompt. A domain can
  be **linked to the launchd agent** that serves its upstream: the row
  then shows the service's state beside the upstream probe, and Start/Stop
  actions drive it without leaving the screen. Below it,
  every name the machine declares (`/etc/hosts`, dnsmasq `address=`
  rules, `/etc/resolver/*`) probed two ways: system resolver vs dnsmasq.
  *Divergent* = something above dnsmasq (NextDNS, secure DNS, cache) is
  rewriting reality; *no answer* = a dead mapping.
  **Extra routes** handle the app that is really two services behind one
  address: a path prefix can go to a different local port while everything
  else keeps going to the main upstream. Coolify is the worked example, with
  its UI on 8000 and its realtime socket expecting `/app/*` on 6001 and
  `/terminal/ws` on 6002 under the same hostname. Without that split the
  socket reports `unavailable` while every other check reads healthy.
  **Browser reach** covers the last hop, the one below every other check.
  When a system proxy is on, macOS hands the hostname to it before the hosts
  file or any resolver is consulted, and a name that exists only on this
  machine cannot exist on the proxy's side, so the request dies there. Cert,
  DNS, and upstream all read healthy and Chrome still says
  `ERR_SOCKS_CONNECTION_FAILED`. Every registered domain therefore carries a
  *Browser* verdict, and one button exempts every registered suffix on every
  network service. The bypass list works by suffix, the same unit as the TLD
  registry, so one entry covers every site under a TLD including ones added
  later. Localhost Manager only adds entries; a suffix's entry is retired only when
  that TLD is deregistered, and nothing another tool put in the list is
  touched.
- **Vanity TLDs** — the suffixes the ingress serves beside `.test`. `.test`
  is the builtin, RFC-reserved default; a vanity TLD (`.1dr0`, `.a8c`, …) is
  an `/etc/resolver/<tld>` file routing the whole suffix to the local
  resolver. The same validated auto-apply queue installs and removes those
  files, or no privileged change is needed when the file already exists.
  Once registered a TLD shows in the add-domain suffix dropdown on Ingress &
  Domains, where individual sites (`ci.1dr0` → a local port) are added exactly
  like `.test` ones. Vanity suffixes resolve only on this Mac.
- **Ports** — all TCP listeners from `netstat` (sees root daemons too),
  with process, user, a *shared port* flag when a wildcard bind and a
  specific bind coexist on one port (the Studio-beside-Caddy
  arrangement), and SIGTERM for listeners you own.
- **Services** — your `am.danielk.*` / `com.danielkam.*` / `dev.1dr0.*`
  launchd jobs, user and system domain, with state, last exit code, log
  tail, plist view and edit, start, stop, enable, disable and kickstart.
  **Add agent** creates one from a form: label, absolute command and
  arguments, working directory, environment, and when it should run. The
  server validates the spec, checks the program exists and is executable
  (launchd has no `PATH`, so a bare command name is the usual cause of a
  crash-looping agent), lints the generated plist with `plutil`, writes it,
  then loads it. **Remove** boots the agent out and deletes its plist,
  keeping the logs, which are usually why you are removing it.
  Owned labels in the user domain only; system daemons stay sudo-in-a-
  terminal territory.

- **DNS chain** — scoped resolvers, default upstream, NextDNS/dnsmasq
  liveness, and the practical order of authority.
- **Activity** — the final sidebar item: the auto-apply worker’s validated
  DNS, hosts, and resolver queue history in a full-pane log, with worker
  version, interrupted-claim warnings, 30-day retention status, refresh, and
  a copy-for-AI diagnostic.

Every screen owns its permalink (`/ingress`, `/tlds`, `/ports`, `/services`,
`/dns`, `/activity`; `/domains` redirects into `/ingress`). All tabular views are
`@wordpress/dataviews` with wrapped cells — no sideways scrolling.

## Run

```sh
npm install
npm start          # builds + serves http://127.0.0.1:4950 (loopback only)
```

Persistent: the `am.danielk.dockmaster` launchd agent runs
`server/index.mjs` with KeepAlive; logs in `~/.local/state/dockmaster/`.
The ingress side needs one privileged install:
`sudo bash <repo>/deploy/install.sh`. This installs both the Caddy daemon and
the auto-apply LaunchDaemon. The UI prints the exact copyable command, derived
from where the repo actually lives.

Auto-apply does not store a sudo password and does not need a Keychain
environment variable. Launchd runs the worker as root after the one-time
install. The worker executes only root-owned copies under
`/Library/Application Support/Dockmaster`, reads only three fixed queue files,
and validates every hostname, address, resolver filename, and operation
before changing `/etc/hosts`, dnsmasq, or `/etc/resolver`. The manual
`apply-dns.sh` and `apply-edits.sh` commands remain available as a fallback.

Proxy bypass is the exception that needs none of this: `networksetup` accepts
proxy writes from an admin account, so Localhost Manager performs them directly and
reads the result back before reporting success. A network service that refuses
the direct write is queued as a `proxy-bypass-set` edit on the same
`observed-edits.json` queue, so the fallback path needs no new watch path and
no new privileged script.

The worker stays alive and checks those queues every two seconds. This avoids
the `WatchPaths` feedback loop caused when a safe atomic queue claim renames
and recreates the watched file. Every real run records its queue sizes,
validated changes, rejections, failures, and outcome in
`/Library/Logs/am.danielk.local-ingress-auto-apply.log`; an idle heartbeat is
written once daily. macOS `newsyslog` rotates the activity log daily and keeps
30 days, and the recent history is visible on Activity.

## Design notes

Express server shelling to `netstat`/`dscacheutil`/`dig`/`scutil`/
`launchctl`/`plutil` and the Docker CLI. Docker discovery is read-only and
only reports published TCP ports that answer an HTTP or HTTPS probe. Mutations
are deliberately narrow: the ingress
registry (user-owned files the root daemon watches), SIGTERM on your own
pids, kickstart and validate-then-swap plist writes on your own user
agents. The loopback server never executes privileged changes. It writes
narrow intent queues that the independently installed root worker validates
again before applying, with backups and serialized runs.
React + `@wordpress/components` + `@wordpress/dataviews` frontend,
WordPress Design Language, Blueberry accent, and a system | light | dark theme
triad. The UI follows Shared Waypoint 1.1.0; `.uiplay.json` is the editable
style and shell declaration.

## Family shell

The app mark is Localhost Manager's distinct Gravatar identicon from
`@1dr0/wpds-identity`. It is generated from a stable non-secret seed and bundled
as a PNG, so there is no external logo request at runtime. The package also
provides the local-operator avatar fallback.

Localhost Manager uses the Shared Waypoint 1.1.0 WPDS shell: near-white surfaces,
a 72px route topbar, a 304px default sidebar that resizes from 240–400px,
and a persistent 72px icon rail when collapsed. The fixed identity header and
local-profile footer frame one scrollable sidebar body. Full-height resize
rails straddle the sidebar and assistant dividers. Main navigation appears
before the utility stack, followed by **Ask Localhost Manager**, **Help & Feedback**,
**App settings**, the AI tip, and Insights. Active navigation uses a quiet
tint and border, never a left stripe.

Authored dropdowns use the shared WPDS `PopoverSelect`; native select menus
are not part of the application interface.

The footer keeps local profile context, appearance, and app version together. README remains repository documentation and is not rendered as a web link because the loopback host does not serve repository Markdown. Localhost Manager has a private loopback service API for its own interface, but it does not claim a public API Reference or MCP server, so the shell does not fabricate those documentation links.

## Ask AI and host boundary

Localhost Manager includes the shared `@1dr0/ai-chat` panel. It receives a redacted,
bounded snapshot of the current section and can navigate between sections. It
has no infrastructure mutation tools.

Direct Anthropic keys stay in page memory. To offer all three a8c bridges
through Localhost Manager's same-origin relay, start the server with:

```sh
AI_CHAT_CLIENT_ID=host-a8c \
AI_CHAT_CLAUDE_API_KEY=<CLAUDE_A8C_CLIENT_API_KEY value> \
AI_CHAT_GEMINI_API_KEY=<GEMINI_A8C_CLIENT_API_KEY value> \
AI_CHAT_CHATGPT_API_KEY=<CHATGPT_A8C_CLIENT_API_KEY value> \
npm start
```

The selector labels these `Claude-a8c` (Anthropic Claude), `Gemini-a8c`
(Google Gemini), and `ChatGPT-a8c` (OpenAI). Claude-a8c is text-only;
Gemini-a8c and ChatGPT-a8c accept image attachments. These API keys are the
matching a8c bridge client bearers, not Anthropic, Google, or OpenAI provider
keys. Bridge credentials remain in the server process and the browser only
receives same-origin endpoints, provider names, and model lists.

The defaults are ports 8789, 8790, and 8791 respectively. Override them with
`AI_CHAT_CLAUDE_UPSTREAM_URL`, `AI_CHAT_GEMINI_UPSTREAM_URL`, or
`AI_CHAT_CHATGPT_UPSTREAM_URL`; override model lists with the corresponding
`*_MODELS` variable. Provider-specific `*_CLIENT_ID` values override the shared
`AI_CHAT_CLIENT_ID`. The old `AI_CHAT_UPSTREAM_URL`, `AI_CHAT_API_KEY`,
`AI_CHAT_MODELS`, and `AI_CHAT_PROVIDER` variables remain supported for one
bridge.

The vendored package is refreshed from UI Playground with
`npm pack --workspace @1dr0/ai-chat`, then installed from
`vendor/1dr0-ai-chat-0.7.2.tgz`.

Localhost Manager has no account system. Its loopback server is the owner boundary and resolves the fixed same-origin bridge configuration. Browser requests cannot choose an upstream or assert owner status. A shared or non-owner host must add real authentication and per-user provider credentials before enabling an assistant route. The panel receives a bounded, redacted snapshot and has no infrastructure mutation, raw shell, repository, or unrestricted terminal tools.
