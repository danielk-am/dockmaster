# Dockmaster ⚓

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

- **Overview** — counts + a warning when NextDNS is sitting above your
  scoped resolvers.
- **Ingress & Domains** — the one screen that views AND manages domains.
  Managed domains live in the registry (`~/.local/share/local-ingress/`):
  add (bare name, `.test` is the fixed suffix), change upstream port, or
  remove — all applied live by the root `caddy run --watch` daemon with
  zero sudo; only brand-new DNS/hosts lines stage for one privileged
  apply, surfaced as numbered steps with a copyable command. Below it,
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
  stay read-only with sudo steps).
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
`sudo bash ~/ai/repos/dockmaster/deploy/install.sh`.

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
