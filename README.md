# Portside ⚓

A local dev infrastructure dashboard for one Mac: every listening port and
who owns it, every local domain and what it *actually* resolves to, your
launchd services with one-click kickstart and log tail, and the DNS chain
in the order it really answers.

Born from a debugging session where `snippets.test` returned NXDOMAIN while
dnsmasq, scoped resolvers, a root Caddy, Studio's wildcard binds, and
NextDNS were all simultaneously "correct." An interface that shows the
collisions beats re-deriving them in a terminal every time.

## Views

- **Overview** — counts + a warning when NextDNS is sitting above your
  scoped resolvers.
- **Ports** — all TCP listeners from `netstat` (sees root daemons too),
  with process, user, and a *shared port* flag when a wildcard bind and a
  specific bind coexist on one port (the Studio-beside-Caddy arrangement).
- **Domains** — every name declared in `/etc/hosts`, dnsmasq `address=`
  rules, and `/etc/resolver/*`, probed two ways: what the system resolver
  answers vs what dnsmasq would say. *Divergent* = something above dnsmasq
  (NextDNS, secure DNS, cache) is rewriting reality; *no answer* = a dead
  mapping.
- **Services** — your `am.danielk.*` / `com.danielkam.*` / `dev.1dr0.*`
  launchd jobs, user and system domain, with state, last exit code, log
  tail, and kickstart (user domain only; system daemons need sudo in a
  terminal).
- **DNS chain** — scoped resolvers, default upstream, NextDNS/dnsmasq
  liveness, and the practical order of authority.

## Run

```sh
npm install
npm start          # builds + serves http://127.0.0.1:4950 (loopback only)
```

Persistent: the `am.danielk.portside` launchd agent runs `server/index.mjs`
with KeepAlive; logs in `~/.local/state/portside/`.

## Design notes

Express server shelling to `netstat`/`dscacheutil`/`dig`/`scutil`/
`launchctl`/`plutil` (read-only; the only mutations are kickstarting your
own user agents and tailing declared log paths under allowed roots).
React + `@wordpress/components` frontend, WordPress Design Language,
Blueberry accent — same mold as the Snippet Manager for Espanso.
