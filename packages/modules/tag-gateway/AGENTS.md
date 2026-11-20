# packages/modules/tag-gateway

User documentation is in [README.md](README.md) (also the npm package page); keep it, and its disclosure box, in step with behaviour changes. The rules for every module are in [`../AGENTS.md`](../AGENTS.md), including [forwarding modules](../AGENTS.md#forwarding-modules) and [opt-in modules](../AGENTS.md#opt-in-modules).

The `tag-gateway` module (`@sharedid-edge/module-tag-gateway`): serves Google's tag gateway for advertisers from paths on the site by forwarding to `<tag ID>.fps.goog`. See the [spec](../../../spec/modules/tag-gateway.md).

- **Opt-in.** `"optIn": true`; never add it to `builtInModules`: the default builds leave core's forwarding code out (`NO_FORWARDING`), so it would be ignored there. It's in the Cloudflare Snippet's `MODULES`, which bundles only what `SID_MODULES` lists.
- **Google's documentation decides** the endpoint, path mapping, headers and caching; cite the page in the README for any change. Don't copy behaviour from third-party proxies.
- **Only `*.fps.goog`.** `GATEWAY_HOSTS` is the module's `forwarding.hosts` and its `sharedidEdge.forwards`; `npm run check:docs` checks they agree. Never add a setting that changes the host.
- **An allow-list, not a deny-list,** for the request headers passed on (`PASSED_ON`) and the cookies (`GOOGLE_COOKIE`, from Google's cookie list). Never copy the request's own `X-Forwarded-*`, client IP or CDN location headers: the client IP and location come from `PlatformInfo`, the full IP and `X-Forwarded-Geolocation` only when core's `preciseLocationDenial` allows them, never truncated.
- **Blocked means nothing sent.** Core decides (opt-out, COPPA, consent providers, TCF, GPC) and refuses `forward` while blocked; the module answers with an empty script or a `204`. Anonymous forwarding sends no `X-Forwarded-*` at all.
- **Settings fail closed.** `tagGatewaySettings` throws on anything unexpected; the module then owns no path and reports `error`.
- **Tests** never reach Google: `test/tag-gateway.test.ts` passes a stub as `forwardFetch`, and the conformance cases (`conformance/cases/module-tag-gateway*.json`, the opt-in build) run against the local stand-in in `conformance/src/upstream-stand-in.ts`.
