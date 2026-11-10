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
- If Prebid.js runs on a different subdomain than the route, set `pixelUrl` to an absolute URL on a host that shares the cookie's domain, and set `SID_COOKIE_DOMAIN`.

**Known Prebid.js issue:** with `extend: true` and `pixelUrl`, `pbjs.getUserIdsAsync()` doesn't resolve on visits after the first, because `sharedIdSystem`'s extend callback never signals completion. Cookies aren't affected, but code that awaits `getUserIdsAsync()` hangs, and with `auctionDelay` above 0 every auction waits the full delay. Until the fix ([prebid/Prebid.js#16135](https://github.com/prebid/Prebid.js/pull/16135)) is released, keep `auctionDelay` at 0 with `extend: true` and `pixelUrl`.

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
