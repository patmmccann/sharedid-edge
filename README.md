# SharedID Edge

SharedID Edge is a small [open-source](https://github.com/patmmccann/sharedid-edge) edge worker that keeps the [Prebid SharedID](https://docs.prebid.org/identity/sharedid.html) durable. It runs on a route of your own domain (`www.example.com/_sid/*`) on the CDN that already serves your site, and sets the SharedID as a **server-set first-party cookie**, so Safari doesn't cap it at 7 days.

It replaces the [WordPress](https://github.com/prebid/sharedid-wordpress) and [Drupal](https://github.com/prebid/sharedid-drupal) SharedID plugins and the endpoint examples in the SharedID docs: it implements the same `pixelUrl` contract, so Prebid.js needs no code change. Unlike those, it answers at the CDN edge, so your origin sees no extra traffic.

It also has a **module** interface for IDs and signals that are best computed at the edge (connecting IP, geography, bot scores, device data), returned to the page in one JSON response. See the [proposal](https://github.com/prebid/prebid-server/issues/5064) for the background.

## How it works

```text
Browser (www.example.com)                       Your CDN, same host: www.example.com/_sid/*
 └─ Prebid.js sharedIdSystem ── pixelUrl ──►  /_sid/sync?id=pubcid:<id>
                                                 ├─ choose the ID (see below)
                                                 └─ Set-Cookie: _pubcid=<id>; Max-Age=31536000; Secure; SameSite=Lax
                                                    Set-Cookie: _pubcid_sv=<id>; …; HttpOnly   (recovery copy)
```

1. Prebid.js's `sharedIdSystem` calls `pixelUrl` with the ID it has (`?id=pubcid:<id>`), on the first visit and, with `extend: true`, on later ones.
2. The worker answers with a 1×1 GIF and sets the ID as a cookie with a one-year lifetime. Cookies set by a first-party server aren't subject to Safari's 7-day cap on cookies written by script.
3. Prebid.js reads the cookie back after the pixel loads, so the server's value wins.
4. The worker also sets an `HttpOnly` copy, `_pubcid_sv`. If Safari caps or clears the script-readable cookie and the page mints a new ID, the next sync restores the original from this copy.

The worker never replaces an existing ID: when you turn it on, it adopts the IDs your visitors already have. It answers only its own routes and never forwards them to your origin, and it never adds cookies to your cacheable pages.

**Why it must run on your site's CDN:** since Safari 16.4, cookies set by a server whose IP address doesn't match the website's are capped at 7 days too. A separate service behind a CNAME doesn't work; a route on the CDN that serves `www.example.com` does.

## Pick your platform

Deploy on the platform that serves your site. Each guide works on its own, from prerequisites to verifying the deployment.

<!-- generated:platforms:start -->
| Platform | How it runs |
| --- | --- |
| [AWS (Lambda and CloudFront)](packages/adapters/aws-lambda/README.md) | A Lambda function behind a `/_sid/*` behaviour of your site's CloudFront distribution. |
| [Azure (Functions and Front Door)](packages/adapters/azure-functions/README.md) | An Azure Functions app behind a `/_sid/*` route of your site's Front Door profile. |
| [Cloudflare Workers](packages/adapters/cloudflare/README.md) | A Worker on a route of your proxied Cloudflare zone (`www.example.com/_sid/*`). |
| [Google Cloud (Cloud Run functions and Load Balancing)](packages/adapters/gcp-functions/README.md) | A Cloud Run function behind a `/_sid/*` path rule of your site's external Application Load Balancer. |
| [Node.js (self-hosted)](packages/adapters/node/README.md) | A Node.js server behind the web server or load balancer that serves your site. |
| [Vercel](packages/adapters/vercel/README.md) | A Next.js route handler, or Routing Middleware, in your site's Vercel project. |
<!-- generated:platforms:end -->

## Turn it on in Prebid.js

Build Prebid.js with `userId` and `sharedIdSystem`, and point `pixelUrl` at the sync route on your own host:

```js
pbjs.setConfig({
  userSync: {
    userIds: [{
      name: 'sharedId',
      params: { pixelUrl: '/_sid/sync', extend: true },
      storage: { type: 'cookie', name: '_pubcid', expires: 365 }
    }]
  }
});
```

[Configure Prebid.js](docs/prebid.md) explains each option, three Prebid.js issues fixed in 11.49.0, and how to pass the modules' output to the auction.

## Modules

Modules are built in, and none runs until you list it in `SID_MODULES`. See [Modules](docs/modules.md).

<!-- generated:modules:start -->
[`bot`](packages/modules/bot/README.md): bot and staff-traffic signals; [`geo`](packages/modules/geo/README.md): the visitor's location as `device.geo`; [`ip`](packages/modules/ip/README.md): the real client IP; [`reflect`](packages/modules/reflect/README.md): keep other first-party cookies durable; [`ua`](packages/modules/ua/README.md): device data and the bot flag; [`dbip`](packages/vendor-modules/dbip/README.md): DB-IP Lite country (vendor module, offline); [`ec`](packages/vendor-modules/ec/README.md): Trusted Server Edge Cookies (vendor module, offline; ⚠ IP-derived ID).
<!-- generated:modules:end -->

## Documentation

Also on the web at [sharedid.dev](https://sharedid.dev).

- [Configure Prebid.js](docs/prebid.md)
- [Responses](docs/responses.md): every route's response, with real output
- [Configuration reference](docs/configuration.md): every `SID_*` setting
- [Consent and opt-out](docs/consent.md): opt-out, GPC, COPPA and TCF
- [Modules](docs/modules.md): choosing modules, `/_sid/sync`, the traffic signal, and the module index
- [Migrate from the WordPress or Drupal plugin](docs/migrating.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md): checks, conformance, adding a module or adapter, and the roadmap
- [Specification](spec/SPEC.md), and the [conformance suite](conformance/AGENTS.md) that tests it

## Contributing

Issues and pull requests are welcome. Read [AGENTS.md](AGENTS.md) and [Development](docs/development.md) first: behaviour changes start in the [specification](spec/SPEC.md), every change ships its docs, and `npm run check` runs what CI runs.

## License

[Apache-2.0](LICENSE)
