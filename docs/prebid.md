# Configure Prebid.js

Deploy SharedID Edge first (see [Pick your platform](../README.md#pick-your-platform)). Deploying it changes nothing on your pages until Prebid.js calls it.

SharedID Edge works with the unmodified `sharedIdSystem` module. Build Prebid.js with `userId` and `sharedIdSystem`, and set `pixelUrl` to the sync route on your own host:

```js
pbjs.setConfig({
  userSync: {
    userIds: [{
      name: 'sharedId',
      params: {
        pixelUrl: '/_sid/sync',   // same host as the page
        extend: true              // re-sync on later visits to refresh the cookie
      },
      storage: {
        type: 'cookie',
        name: '_pubcid',          // must match SID_COOKIE_NAME
        expires: 365
      }
    }]
  }
});
```

- **`extend: true`** makes Prebid.js call `pixelUrl` on later visits too, which refreshes the cookie's lifetime. The response is cached privately by the browser for a day (`SID_SYNC_CACHE_SECONDS`), so a frequent visitor triggers at most about one request a day. Cookie-only modules such as `reflect` and `ec` also run on these calls; see [Modules on `/_sid/sync`](modules.md#modules-on-_sidsync).
- **`storage.type` must be `cookie`**, so the page and the worker share the ID. `html5` (localStorage) won't pick up the server's cookie.
- **The cookie's name and domain must match on both sides.** `SID_COOKIE_NAME` is `storage.name` (`_pubcid` here). `SID_COOKIE_DOMAIN` (required) is the domain Prebid.js writes the cookie on. `sharedIdSystem` picks the highest domain it can set a cookie on, so that's normally your registrable domain: `example.com` for a site on `www.example.com`. To check, look at `_pubcid`'s Domain in your browser's developer tools on a page without the worker. With a different domain, the browser keeps two `_pubcid` cookies, and Prebid.js and the worker each read their own (see [Troubleshooting](troubleshooting.md)).
- **With `storageControl` in Prebid.js 11.48.0 or earlier** (fixed in 11.49.0), `sharedIdSystem` can't find the registrable domain: `storageControl` blocks the probe cookie it uses (`_gd…_sharedId`), which those releases don't disclose, so it writes `_pubcid` host-only. Prebid.js [#16156](https://github.com/prebid/Prebid.js/pull/16156), in 11.49.0, fixes that. On older versions, either leave `storageControl` out or set its `enforcement` to `off`, or set `SID_COOKIE_DOMAIN=host-only` to match.
- If Prebid.js runs on a different subdomain than the route, set `pixelUrl` to an absolute URL on a host under the cookie's domain (`SID_COOKIE_DOMAIN`).

**Fixed in Prebid.js: `getUserIdsAsync()` didn't resolve with `extend: true`.** The fix, [prebid/Prebid.js#16135](https://github.com/prebid/Prebid.js/pull/16135), is in Prebid.js 11.49.0. In 11.48.0 and earlier, with `extend: true` and `pixelUrl`, `pbjs.getUserIdsAsync()` doesn't resolve on visits after the first, because `sharedIdSystem`'s extend callback never signals completion. Cookies aren't affected, but code that awaits `getUserIdsAsync()` hangs, and with `auctionDelay` above 0 every auction waits the full delay. On those versions, keep `auctionDelay` at 0 with `extend: true` and `pixelUrl`.

**Fixed in Prebid.js: the first visit's cookie was rewritten by script.** The fix, [prebid/Prebid.js#16136](https://github.com/prebid/Prebid.js/pull/16136), is in Prebid.js 11.49.0. In 11.48.0 and earlier, on a first visit, `sharedIdSystem` mints an ID, calls `pixelUrl`, and when the pixel loads it stores the ID again with `document.cookie`, straight after the worker's `Set-Cookie`. That makes the cookie script-set again, so Safari's 7-day cap applies to it until the next sync re-sets it from the server (with `extend: true`, the next visit after `SID_SYNC_CACHE_SECONDS`). The `HttpOnly` recovery copy (`_pubcid_sv`) isn't affected, so if Safari clears the cookie in the meantime, the next sync restores the original ID. The same rewrite also puts back a cookie the worker deleted for GPC, COPPA or denied consent, until the next sync deletes it again. On those versions, no configuration avoids the rewrite.

## Module output: `/_sid/v1`

The SharedID itself needs nothing more. Modules that return data (see [Modules](modules.md)) put it in the `/_sid/v1` payload, as an OpenRTB `ortb2` fragment (the whole payload is in [Responses](responses.md#get-_sidv1-the-id-and-the-modules-output)). On the page, merge it into Prebid.js's first-party data before the auction:

```js
fetch('/_sid/v1', { credentials: 'include' })
  .then(response => response.json())
  .then(payload => {
    if (payload.ortb2) pbjs.que.push(() => pbjs.mergeConfig({ ortb2: payload.ortb2 }));
  })
  .catch(() => {});
```

To read `/_sid/v1` from a page on another origin, list that origin in `SID_ALLOWED_ORIGINS` (see [Responses](responses.md#get-_sidv1-the-id-and-the-modules-output)).

## Encrypted client IP: Google Publisher Tag and Prebid Server

The opt-in [`encrypted-ip` module](../packages/modules/encrypted-ip/README.md) returns the visitor's IP address encrypted (HPKE, [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180)) to each recipient you configure, in the payload's `eip`, not in `ortb2`: every bidder gets `ortb2`, and each value is for one recipient only.

**Google Publisher Tag** takes `eip.google.value` as its [publisher-provided IP address](https://developers.google.com/publisher-tag/guides/unmasked-ip/publisher-provided#encrypt_ip_address) (encrypted to [Google's key](https://www.gstatic.com/real-ip/ip_enc_key.json)). Call `googletag.setConfig({ ipAddress })` before `enableServices`, `display` or `refresh`: it only affects later ad requests. With Prebid.js and GPT on the same page, one `/_sid/v1` request serves both: start it early, apply its `ortb2` to Prebid.js and its `eip.google` to GPT, and hold the first ad request until it answers or a short timeout passes:

```js
const sid = Promise.race([
  fetch('/_sid/v1', { credentials: 'include' }).then(response => response.json()),
  new Promise(resolve => setTimeout(resolve, 300, {}))
]).catch(() => ({}));

pbjs.que.push(async () => {
  const payload = await sid;
  if (payload.ortb2) pbjs.mergeConfig({ ortb2: payload.ortb2 });
  // … pbjs.requestBids(…), then googletag.pubads().refresh() as usual
});

googletag.cmd.push(async () => {
  const payload = await sid;
  const ipAddress = payload.eip?.google?.value;
  if (ipAddress) googletag.setConfig({ ipAddress });   // before enableServices, display and refresh
  googletag.enableServices();
});
```

To check, filter the browser's Network tab for `/gampad/ads`: its `ips` parameter carries the value, URL-encoded.

**Prebid Server (experimental)** would take `eip.pbs[<host>].value` as `device.ext.prebid.eip`, decrypt it with its own key into `device.ip` or `device.ipv6`, and mask it under its usual privacy rules ([prebid/prebid-server#5106](https://github.com/prebid/prebid-server/issues/5106)). Values are keyed by the host of each `s2sConfig` endpoint, so a page with several Prebid Server hosts sends each its own. Prebid.js doesn't send it yet: [prebid/Prebid.js#16281](https://github.com/prebid/Prebid.js/issues/16281) proposes that the `sharedIdEdge` RTD module read `eip.pbs` from `/_sid/v1` and send each value to its Prebid Server host only, never to client-side bidders. Until then, don't put it in `pbjs.mergeConfig({ ortb2 })`, which every bidder would get. Neither proposal has shipped; the field name may change.
