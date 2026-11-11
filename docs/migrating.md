# Migrate from the WordPress or Drupal plugin

The plugins and SharedID Edge implement the same contract, so switching is a configuration change:

1. Deploy SharedID Edge and verify it (see [Pick your platform](../README.md#pick-your-platform)). Keep the plugin installed for now.
2. In your [Prebid.js configuration](prebid.md), change `pixelUrl` from `/wp-json/pubcid/v1/extend/` (WordPress) or `/pubcid` (Drupal) to `/_sid/sync`.
3. Use the same cookie name as the plugin (its default is `_pubcid`, the same as here), and the same domain as Prebid.js: `SID_COOKIE_DOMAIN` is required, normally your registrable domain (`example.com`). If the plugin's "Cookie Domain" was empty, its cookies were host-only while Prebid.js wrote its own on the registrable domain; set the registrable domain here to end that split. The worker deletes the plugin's old host-only `_pubcid` the first time a browser sends it next to the domain cookie, keeping the older value.
4. Once the new `pixelUrl` is live, uninstall the plugin.

Existing visitors keep their IDs: the worker adopts the cookie the plugin set. Two differences:

- **First visits:** the plugins only re-set a cookie that already exists, so a new visitor's first sync sets nothing unless you configured a "Generate Function". SharedID Edge adopts the ID Prebid.js sends with the first sync, so new visitors get a server-set cookie straight away.
- **Consent:** the plugins call a PHP "Consent Function". SharedID Edge checks consent itself; see [Consent and opt-out](consent.md).
