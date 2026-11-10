# Consent and opt-out

**Opt-out.** If the `_pubcid_optout` cookie is present, the worker sets no ID and expires any it finds; Prebid.js checks the same cookie. Link your privacy page to `https://www.example.com/_sid/optout` to opt a browser out, and `/_sid/optin` to undo it.

**Global Privacy Control and COPPA.** A request with `Sec-GPC: 1`, or with `coppa=1` (a site or page directed at children, as in OpenRTB `regs.coppa`), gets no ID, and any ID cookies it carries are deleted. Prebid.js doesn't call `pixelUrl` for COPPA requests, so for sync requests this only matters for other callers. Pages that fetch `/_sid/v1` themselves should add `coppa=1` when it applies.

**TCF.** Whenever a request carries a TCF TC string, the worker checks it before setting the cookie:

- **Publisher mode** (the default). SharedID is your own first-party ID, so the worker reads the **publisher** consents (the TC string's publisher TC segment): it needs consent for Purpose 1 (store and access information on a device), and consent or legitimate interest for at least one of Purposes 2 to 10. Configure your CMP to ask for publisher consent for these purposes, or it won't include a publisher TC segment and no one gets a server cookie.
- **Vendor mode.** If your company is registered as a TCF vendor, set `SID_VENDOR_ID` to your vendor ID. The worker then needs consent for that vendor, consent for Purpose 1, and consent or legitimate interest for at least one of Purposes 2 to 10, all from the vendor part of the TC string instead of the publisher segment.

When GDPR applies and there's no TC string, that counts as no consent: the worker sets nothing and deletes the ID cookies. GDPR applies when Cloudflare places the request in the EU (`request.cf.isEUCountry`; behind CloudFront, `CloudFront-Viewer-Country` is one of the 27 EU member states; on Vercel, `x-vercel-ip-country` is; behind Azure Front Door, the country its rule passes on is; behind Google Cloud's load balancer, `{client_region}` is), or when the request says so with `gdpr=1`.

The TC string comes from the CMP's `euconsent-v2` cookie, or a `gdpr_consent` parameter. Prebid.js doesn't add consent parameters to `pixelUrl`, so for the sync route **your CMP must store the TC string in the `euconsent-v2` cookie** (check yours: some keep it only in local storage). Without it, EU visitors get no server cookie, which is the safe failure. Sending the consent strings from Prebid.js to the worker is planned.

**Deleting the cookie.** When consent is missing or withdrawn, or with GPC, COPPA or opt-out, the worker deletes the ID cookies it finds: it overwrites each with an empty value, `Max-Age=0` and an `Expires` date in 1970, which browsers treat as a delete. With `SID_COOKIE_DOMAIN` set, it deletes a host-only copy too.

**What's stored and logged.** SharedIDs are random UUIDs, never derived from the IP address or other request data. (The opt-in `ec` module is the exception: see [its README](../packages/modules/ec/README.md).) The worker stores nothing server-side and logs nothing about requests (Workers observability is off in the default config).
