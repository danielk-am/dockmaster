# Dockmaster

The local dev infrastructure control plane for one Mac: every listening
port and who owns it, every local domain and what it *actually* resolves
to, your launchd services with editing/kickstart/log tail, the DNS chain
in the order it really answers — and the portless `*.test` ingress
manager (registry → Caddy site blocks → mkcert certs) absorbed from the
old Local Ingress tool.

Born from a debugging session where `snippets.test` returned NXDOMAIN while
dnsmasq, scoped resolvers, a root Caddy, Studio's wildcard binds, and
NextDNS were all simultaneously "correct." An interface that shows the
collisions — and can fix them — beats re-deriving them in a terminal every
time.

## Views

- **Overview** — a rotating, fixed-height orientation hero followed by three
  stacked Quick Start journeys and the live machine snapshot. Reduced-motion
  mode keeps the first hero variant. Journeys lead into domain setup, port
  investigation, and service recovery without replacing the underlying tools.
- **Ingress & Domains** — the one screen that views AND manages domains.
  Managed domains live in the registry (`~/.local/share/local-ingress/`):
  add (bare name, `.test` is the fixed suffix), change upstream port, or
  remove — all applied live by the root `caddy run --watch` daemon with
  zero sudo; only brand-new DNS/hosts lines stage for one privileged
  apply, surfaced as numbered steps with a copyable command. A domain can
  be **linked to the launchd agent** that serves its upstream: the row
  then shows the service's state beside the upstream probe, and Start/Stop
  actions drive it without leaving the screen. Below it,
  every name the machine declares (`/etc/hosts`, dnsmasq `address=`
  rules, `/etc/resolver/*`) probed two ways: system resolver vs dnsmasq.
  *Divergent* = something above dnsmasq (NextDNS, secure DNS, cache) is
  rewriting reality; *no answer* = a dead mapping.
- **Vanity TLDs** — the suffixes the ingress serves beside `.test`. `.test`
  is the builtin, RFC-reserved default; a vanity TLD (`.1dr0`, `.a8c`, …) is
  an `/etc/resolver/<tld>` file routing the whole suffix to the local
  resolver, staged as one privileged apply (the same `apply-edits.sh` run as
  every observed edit) — or zero sudo when the resolver file already exists.
  Once registered a TLD shows in the add-domain suffix dropdown on Ingress &
  Domains, where individual sites (`ci.1dr0` → a local port) are added exactly
  like `.test` ones. Vanity suffixes resolve only on this Mac.
- **Ports** — all TCP listeners from `netstat` (sees root daemons too),
  with process, user, a *shared port* flag when a wildcard bind and a
  specific bind coexist on one port (the Studio-beside-Caddy
  arrangement), and SIGTERM for listeners you own.
- **Services** — your `am.danielk.*` / `com.danielkam.*` / `dev.1dr0.*`
  launchd jobs, user and system domain, with state, last exit code, log
  tail, kickstart, and in-place plist **editing** for user agents (saves
  are `plutil`-linted before they replace the live file; system daemons
  stay read-only with sudo steps). Full lifecycle for user agents:
  **Start/Stop** (bootstrap/bootout in the gui domain) and
  **Enable/Disable** — disabling parks the plist under a `.disabled`
  suffix (the convention the archive folders already use) so login skips
  it, and disabled agents stay listed for one-click re-enable.
- **DNS chain** — scoped resolvers, default upstream, NextDNS/dnsmasq
  liveness, and the practical order of authority.

Every screen owns its permalink (`/ingress`, `/tlds`, `/ports`, `/services`,
`/dns`; `/domains` redirects into `/ingress`). All tabular views are
`@wordpress/dataviews` with wrapped cells — no sideways scrolling.

## Run

```sh
npm install
npm start          # builds + serves http://127.0.0.1:4950 (loopback only)
```

Persistent: the `am.danielk.dockmaster` launchd agent runs
`server/index.mjs` with KeepAlive; logs in `~/.local/state/dockmaster/`.
The ingress side needs the root daemon once:
`sudo bash <repo>/deploy/install.sh` — the UI prints the exact copyable
command, derived from where the repo actually lives (the deploy scripts
resolve their own location, so a repo move can't strand them again).

## Design notes

Express server shelling to `netstat`/`dscacheutil`/`dig`/`scutil`/
`launchctl`/`plutil`. Mutations are deliberately narrow: the ingress
registry (user-owned files the root daemon watches), SIGTERM on your own
pids, kickstart and validate-then-swap plist writes on your own user
agents. Anything privileged is never executed by the server — it is
staged and handed to you as a copyable sudo command.
React + `@wordpress/components` + `@wordpress/dataviews` frontend,
WordPress Design Language, Blueberry accent, system | light | dark theme
triad — same mold as the Snippet Manager for Espanso.

## Family shell

Dockmaster uses the flush standalone WPDS family shell. Default app, sidebar,
and content surfaces are white. The left panel has a fixed identity header and
local-profile footer, with one scrollable body between them. Its width persists
independently from collapse and uses the shared `@1dr0/ai-chat` 0.7.1 short
resize handle on the panel's right edge.

Main navigation appears before the utility stack. Utilities stay in the shared
order: **Ask Dockmaster**, **Help & Feedback**, then **App settings**. Active
navigation uses background and weight, never a left stripe. Authored dropdowns
use the shared `PopoverSelect`; native select menus are not part of the app UI.

The generated 36px product mark and 28px local-operator avatar use
`@1dr0/wpds-identity` with stable, non-secret seeds and no external image
request. Optional generated logo explorations remain in `public/` as static
assets. Runtime identity stays deterministic.

README remains repository documentation and is not rendered as a web link
because the loopback host does not serve repository Markdown. Dockmaster has a
private loopback service API for its interface, but it does not claim a public
API Reference or MCP server, so the shell does not fabricate those links.

## Ask AI and host boundary

Dockmaster includes the shared `@1dr0/ai-chat` panel. It receives a redacted,
bounded snapshot of the current section and can navigate between sections. It
has no infrastructure mutation tools.

Default `public/ai-chat-config.js` mode is direct. Direct Anthropic keys stay in
page memory. `server/ai-bridge-config.mjs` provides the same-origin relay
registry for a host that wires Dockmaster to the Claude-a8c, Gemini-a8c, or
ChatGPT-a8c bridges. Bridge credentials belong in the server process; browser
configuration carries only endpoints, provider names, and model lists.

Dockmaster has no account system. Its loopback server is the owner boundary. A
shared or non-owner host must add authentication and per-user provider
credentials before enabling an assistant route. Browser requests cannot choose
an upstream or assert owner status.

Vendored packages are refreshed from UI Playground with `npm pack`, then
installed from `vendor/1dr0-ai-chat-0.7.1.tgz` and
`vendor/1dr0-wpds-identity-0.1.0.tgz`.
