# Changelog

## Unreleased

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
