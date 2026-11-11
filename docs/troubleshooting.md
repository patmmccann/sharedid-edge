# Troubleshooting

Responses carry two debug headers: `X-SharedID-Source` (`cookie`, `recovery`, `param` or `minted`: where the ID came from) and, when no cookie was set, `X-SharedID-Status` with the reason (for example `denied: opt-out` or `denied: tcf: no consent for purpose 1`). See [Debugging headers](responses.md#debugging-headers).

| Symptom | Check |
| --- | --- |
| `/_sid/sync` returns your site's 404 page | The route isn't attached or doesn't match: check `routes` in `wrangler.jsonc`, that the hostname is proxied (orange cloud), and `SID_BASE_PATH`. |
| `/_sid/sync` returns the worker's plain `Not found` | The path under `SID_BASE_PATH` is wrong: it must end in `/sync`, `/v1`, `/optout` or `/optin`. |
| No `set-cookie` in the response | See `X-SharedID-Status`. In `tcf` mode, check the `euconsent-v2` cookie exists. |
| Every request gets a 500, and the log says `SID_COOKIE_DOMAIN is required` | Set `SID_COOKIE_DOMAIN` to the domain Prebid.js writes `_pubcid` on, normally your registrable domain (`example.com`), or `host-only`. See [Configure Prebid.js](prebid.md). |
| Two `_pubcid` cookies in the browser, with different values or Domains; the ID changes between page and server | `SID_COOKIE_DOMAIN` doesn't match the domain Prebid.js writes `_pubcid` on. Set it to that domain (normally your registrable domain), then clear the extra cookie. With Prebid.js 11.48 or earlier and `storageControl`, see [Configure Prebid.js](prebid.md). |
| Cookie set but gone after a week in Safari | Run `verify-deployment`: the endpoint's IP addresses probably don't match the site's. |
| Cookie not readable by Prebid.js | The cookie name or domain doesn't match Prebid.js's `storage` config, or the page and the route are on hosts the cookie's domain doesn't cover. |
| A 500 with "misconfigured" | A setting is invalid: `npm exec -w @sharedid-edge/cloudflare -- wrangler tail` shows the reason (on AWS, the function's CloudWatch logs; on Vercel, the project's logs; on Azure, the function app's logs; on Google Cloud, the function's logs in Cloud Logging). |
| `getUserIdsAsync()` never resolves | A Prebid.js issue in 11.48.0 and earlier, fixed in 11.49.0 (prebid/Prebid.js#16135); see [Configure Prebid.js](prebid.md). |

Each adapter's README has a troubleshooting table for its platform, and each module's README one for the module.
