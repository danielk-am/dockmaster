# Changelog

## Unreleased

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
