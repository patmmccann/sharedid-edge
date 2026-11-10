# The `geo` module

Part of the [SharedID Edge specification](../SPEC.md). The general rules for modules, including consent, time limits and [modules on `/sync`](../SPEC.md#modules-on-sync), are there.

Name `geo`; no `purposes`, no `gvlid`. It runs only when listed in `SID_MODULES`, and on `/v1` only.

It returns the platform's location as the OpenRTB 2.6 `ortb2.device.geo` object:

| `device.geo` | From | |
| --- | --- | --- |
| `type` | | `2` (IP address), whenever any other field is present. |
| `country` | country | ISO 3166-1 **alpha-3** (`USA`), from a bundled table of every assigned code. Codes not in the table are left out. |
| `region` | region | The subdivision code without the country prefix (`US-TX` and `TX` are both `TX`), upper case. |
| `metro` | metro code | A string, as in OpenRTB. |
| `utcoffset` | time zone | The zone's offset from UTC in minutes at the time of the request, so it follows daylight saving time. Left out when the zone is unknown to the runtime. |
| `city` | city | Precise. |
| `zip` | postal code | Precise. |
| `lat`, `lon` | latitude, longitude | Precise; numbers. |

- **Coarse** fields (`type`, `country`, `region`, `metro`, `utcoffset`) are always returned when known.
- **Precise** fields (`city`, `zip`, `lat`, `lon`) are returned in full or not at all; they MUST NOT be rounded or truncated. They're left out under the same conditions as the `ip` module's address:
  - the request has `Sec-GPC: 1`, or `coppa=1`;
  - the `us_privacy` string opts out of sale (its third character is `Y`);
  - there is a TC string that is invalid or doesn't opt in to Special Feature 1 (use precise geolocation data);
  - GDPR applies and there is no TC string.
- **Setting:** `SID_MODULE_CONFIG={"geo":{"precision":"coarse"}}` returns only the coarse fields; `"precise"` is the default. Any other value of `precision`, or any other key, is a configuration mistake: the module fails (status `error`) on every request rather than guess.
- When there's no field to return, it returns nothing (status `empty`).
- The location MUST NOT be stored, logged or used to derive an ID.
