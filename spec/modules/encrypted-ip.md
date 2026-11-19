# The `encrypted-ip` module

Part of the [SharedID Edge specification](../SPEC.md). The general rules for modules, including consent, time limits and [scheduled data updates](../SPEC.md#scheduled-data-updates), are there.

Name `encrypted-ip`; no `purposes`, no `gvlid`; `routes` `v1` only. An opt-in project module ([`packages/modules/encrypted-ip`](../../packages/modules/encrypted-ip/README.md)), added at build time, that runs only when listed in `SID_MODULES`. It encrypts the client's IP address to the public key of each configured recipient and returns the results as the payload's [`eip`](../SPEC.md#payload-v1), so that the page can hand each value to its recipient:

- **Google:** Google Publisher Tag's [publisher-provided IP address](https://developers.google.com/publisher-tag/guides/unmasked-ip/publisher-provided#encrypt_ip_address), which the page passes with `googletag.setConfig({ ipAddress })`. Google's key is published at [`https://www.gstatic.com/real-ip/ip_enc_key.json`](https://www.gstatic.com/real-ip/ip_enc_key.json).
- **Prebid Server hosts (experimental):** the same scheme with a Prebid Server host's own key, as proposed in [prebid/prebid-server#5106](https://github.com/prebid/prebid-server/issues/5106), for the request field `device.ext.prebid.eip`, which Prebid Server would decrypt into `device.ip` or `device.ipv6`; [prebid/Prebid.js#16281](https://github.com/prebid/Prebid.js/issues/16281) proposes that Prebid.js send it to Prebid Server only. Neither has shipped: this recipient, and the field name, may change until they do.

**Not an ID.** The project's modules derive no ID from the IP address ([IP-derived IDs](../../packages/vendor-modules/AGENTS.md#ip-derived-ids)), and this module doesn't either: each value is the address itself, encrypted with a fresh ephemeral key for every request, so two values for the same address differ and can't be linked without the recipient's private key. Only the recipient can read it, and it is subject to the same consent rules as the plain address of the [`ip`](ip.md) module. That's why it's a project module and not a vendor module.

## Recipients and settings

`SID_MODULE_CONFIG["encrypted-ip"]`:

- `google`: Google, when present.
- `pbs`: an object keyed by Prebid Server host name: the host, in lower case, with `:port` when it isn't the default (`pbs.example.com`, `pbs.example.com:8443`), the host of the Prebid.js `s2sConfig` endpoint it's for. Each listed host is a recipient.

Each recipient is on only when listed; any combination works (Google alone, Prebid Server alone, both). Each recipient's entry is an object with:

- `key` (optional): the recipient's **key file**, as Google publishes one: `{ "keys": [ { "kty": "OKP", "crv": "X25519", "kid": …, "x": … } ] }`, with **exactly one key**, the active one. `x` is 32 bytes of unpadded base64url; `kid` is required, printable ASCII without spaces, at most 256 characters. Recipients rotate by keeping their previous private keys for a while, not by listing several public keys, so a file with no key or more than one is invalid, never guessed at. Other members are ignored, except a private part (`d`), which is refused.
- `keyFetched` (optional, needs `key`): when that copy was fetched, an ISO 8601 date and time with a time zone (`Z` or an offset).
- `keyMaxAge` (optional, needs `keyFetched`): the key file's `Cache-Control` `max-age` when it was fetched, in whole seconds.

Without `key`, the recipient's key comes from a scheduled snapshot ([Keys](#keys)); a recipient with both is an error. Any other setting, a malformed value (an invalid key file included), no recipient at all, or a `pbs` key that isn't a lower-case host name (with an optional port) makes the module an `error`, with no output.

## Keys

Keys are never fetched while answering a request. Each comes either from the settings, or from a snapshot that the opt-in updater ([`@sharedid-edge/data-updates`](../../packages/data-updates/README.md)) downloads on a schedule: Google's from its fixed URL, a Prebid Server host's from the key file URL its operator publishes (`https:` only). The updater validates the file (exactly one X25519 key, as above) before publishing it, keeps the previous snapshot when a download fails or the file is invalid, and stores only `{ kid, x }` and the file's `Cache-Control` `max-age` (`no-store` or `no-cache` count as 0), if any. An implementation SHOULD import each key into its crypto library once, when the key is loaded or reloaded, rather than for every value.

The rules follow [Google's guide](https://developers.google.com/publisher-tag/guides/unmasked-ip/publisher-provided#encrypt_ip_address), for Google and Prebid Server hosts alike: cache the key, refresh it at least every 24 hours, or sooner when `Cache-Control` says so; a value encrypted with a key fetched within the preceding 24 hours keeps decrypting during a rotation, and nothing is promised beyond that. A key's age is the time since it was fetched: `keyFetched`, or the snapshot's last successful check (an unchanged download counts).

- **Fresh** until its refresh time: the recorded `max-age`, held to at least 1 minute and at most 24 hours, or 1 hour when there's none. Its values have no `stale` flag.
- **Stale** past its refresh time, or more than 5 minutes ahead of the worker's clock: still used, its value marked `stale: true`, so a failing updater shows long before values stop.
- **Expired** more than 24 hours after it was fetched: **no value** for that recipient.
- **Missing** (no key setting and no snapshot): no value, with no error.

Stale, expired and missing keys all make the module report `stale: true`. A `key` setting without `keyFetched` has no age: it's always fresh. Such a static key stops working with Google once Google rotates it, so it suits tests, or deployments that replace it, with its fetch time, at least daily.

## Encryption

For each recipient with a key: HPKE ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180)) in base mode (`0x00`), with DHKEM(X25519, HKDF-SHA256) (`0x0020`), HKDF-SHA256 (`0x0001`) and AES-256-GCM (`0x0002`), empty `info` and `aad`, a single-shot message with a fresh ephemeral key pair. The plaintext is the UTF-8 bytes of the bare address: IPv4 in dotted decimal (an IPv4-mapped IPv6 address is IPv4), IPv6 in RFC 5952 form, without port, brackets, prefix or whitespace. The value is `enc` (32 bytes) followed by the ciphertext and its 16-byte tag, as unpadded base64url: 32 + the address's length + 16 bytes, 67 to 124 characters for any address. Implementations MUST pass RFC 9180's published test vector for this suite.

## Output

`{ "eip": { "google": { "value", "kid", "stale"? }, "pbs": { "<host>": { "value", "kid", "stale"? } } } }`, with an entry for each recipient that has a usable (fresh or stale) key, and nothing else; `kid` is the key's. The module's report is `ok` when there's at least one value, `empty` otherwise, with `stale: true` as above. Nothing goes into `ortb2`.

It returns **no value for any recipient** (status `empty`) when:

- the request has `Sec-GPC: 1`, or `coppa=1`;
- the `us_privacy` string opts out of sale;
- there is a TC string that is invalid or doesn't opt in to Special Feature 1 (use precise geolocation data), or GDPR applies and there is no TC string;
- the browser has opted out (the opt-out cookie), or a [consent provider](../SPEC.md#consent-providers) refused (the storage decision is denied for a reason other than TCF's own);
- the platform has no client IP, or it isn't a valid address.

These are the [`ip`](ip.md) module's rules, plus the opt-out cookie and consent providers. Under TCF, Special Feature 1 decides, as for the plain address.

## Privacy

- The address, plain or encrypted, MUST NOT be stored, logged or used to derive an ID. Nothing from a request is kept for the next: no cache of values per address.
- Only public keys are configured or stored; no secret is needed.
- Each value is for its recipient alone. Pages SHOULD pass Google's only to Google Publisher Tag, and a Prebid Server host's only to that host, never to client-side bidders (which is why it isn't in `ortb2`).

## Runtimes

The module needs Web Crypto's X25519 (`generateKey`, `exportKey`, `deriveBits`), HMAC-SHA256 and AES-GCM. A runtime without X25519 makes it an `error` (no value), which the target's conformance `limitations` list: Akamai EdgeWorkers and Fastly Compute, whose Web Crypto has none.
