# Changelog

## Unreleased

- Launchd agents can now be **created and removed**, not only managed. Every
  other verb was already here (start, stop, enable, disable, kickstart, log
  tail, plist view and edit), so a new service still meant hand-writing XML
  into `~/Library/LaunchAgents` and a dead one meant `launchctl bootout` plus
  `rm` in a terminal. **Add agent** takes a label, an absolute command and its
  arguments, an optional working directory and environment, and when it should
  run. **Remove** boots the agent out and deletes its plist, keeping its logs.
- The create path fails early where launchd fails late. It refuses a label
  outside the owned namespace, a relative program path, a program that does not
  exist or is not executable, and an agent with no trigger at all (no keep
  alive, no run at load, no interval), which would otherwise be created and
  simply never run. launchd has no `PATH` of its own, so a bare command name is
  the most common reason a new agent crash-loops; that is now a 400 rather than
  a mystery in a log.
- The generated plist goes through the same validate-then-swap the editor uses:
  `plutil -lint`, then a round-trip check that it is a dictionary declaring the
  label asked for, before it lands. A plist that fails is never written. A
  plist that writes but fails to load is kept, with the launchctl error
  reported, so it can be fixed in the editor rather than silently rolled back.
- Creating an agent whose label already exists is refused, including when the
  existing copy is parked under a `.disabled` suffix. Creating over one of
  those would have silently resurrected the old agent at next login.
- Restart policy is a real choice: keep alive always, restart only after a
  crash (`KeepAlive` as a `SuccessfulExit` dict), or never. "Never" omits the
  key rather than writing `false`.
- `server/launchd-lib.mjs` holds the spec validation and plist builder as pure
  functions, covered by `test/launchd-create.mjs`, including XML escaping and
  a comment that cannot break out of its own comment.

- Added extra routes: a registered domain can now send one path prefix to a
  different local port. Some apps are two services behind one origin. Coolify
  serves its UI on 8000 while its realtime socket dials the same hostname and
  expects the proxy to hand `/app/*` to soketi on 6001 and `/terminal/ws` to
  6002. A single `reverse_proxy` sends those to the app, which answers with
  HTML, and the socket sits at `unavailable` while cert, DNS, upstream, and
  browser reach all read healthy. Registered domains gained a Routes column
  and an **Extra routes…** action.
- The generated site block is byte-identical for domains with no extra
  routes, so the feature rewrites nothing that did not ask for it.

- Added Browser reach to Ingress & Domains: the proxy hop between a correctly
  served domain and a working browser. A registered domain can have a minted
  cert, an applied hosts line, and a live upstream, and still fail in Chrome
  with `ERR_SOCKS_CONNECTION_FAILED`, because a system proxy resolves the
  hostname on its own side before the hosts file is ever consulted. Every
  registered domain now carries a Browser verdict, a suffix that the proxy
  still claims raises the alarm on the screen, and one button exempts every
  registered suffix on every network service.
- Proxy bypass writes need no password: `networksetup` accepts them from an
  admin account. A service that refuses falls back to the same validated queue
  as the hosts, dnsmasq, and resolver edits, through a new `proxy-bypass-set`
  kind, so the root worker needs no new watch path.
- Deregistering a vanity TLD now retires its `*.<tld>` proxy exemption too.

- Moved Local operator editing to the dedicated `/profile` page and made its
  footer trigger fill the available sidebar width. Profile settings no longer
  use an overlay.

- Made the Local operator footer profile editable with the shared generated or
  uploaded avatar, validation, focus return, and app-scoped persistence.

- Replaced the semantic app mark with its distinct bundled Gravatar identicon.
- Added `@1dr0/wpds-identity` for the product mark and local-operator avatar.
