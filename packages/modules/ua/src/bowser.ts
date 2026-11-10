import Bowser from 'bowser';
import { isbot } from 'isbot';
import type { EdgeModule } from '@sharedid-edge/core';
import { createUaModule } from './module.js';
import { MAX_UA_LENGTH, type ParsedUserAgent, type UserAgentParser } from './parse.js';

type DeviceClass = NonNullable<ParsedUserAgent['type']>;

function isDeviceClass(type: string | undefined): type is DeviceClass {
  return type === 'mobile' || type === 'tablet' || type === 'desktop' || type === 'tv';
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Values browsers freeze in the User-Agent, which say nothing about the device:
 * - macOS is always `10.15.7` (or `10.15` in Firefox), whatever the version;
 * - Windows 10 and 11 are both `Windows NT 10.0`;
 * - Chrome's reduced Android User-Agent is always `Android 10; K`.
 */
function frozenOsVersion(ua: string, os: string, version: string): boolean {
  if (os === 'macOS') return version === '10.15.7' || version === '10.15';
  if (os === 'Windows') return version === 'NT 10.0';
  if (os === 'Android') return version === '10' && /;\s*K\)/.test(ua);
  return false;
}

/** On Windows the release is Bowser's `versionName` (`7`, `8.1`, `XP`): `version` is the NT version. */
function osVersion(ua: string, os: string, version: string | undefined, versionName: string | undefined): string | undefined {
  if (version === undefined || frozenOsVersion(ua, os, version)) return undefined;
  return os === 'Windows' ? versionName : version;
}

/**
 * Full User-Agent parsing with [Bowser](https://github.com/bowser-js/bowser) (browser, OS, device class, maker and
 * model) and [isbot](https://github.com/omrilotan/isbot) (self-identified crawlers and automated clients). Values
 * browsers freeze are left out rather than reported wrong. Adds about 12 KB gzipped to a bundle.
 */
export const bowserParser: UserAgentParser = userAgent => {
  const ua = userAgent.slice(0, MAX_UA_LENGTH);
  const result = Bowser.parse(ua);
  const browserName = nonEmpty(result.browser.name);
  const browserVersion = nonEmpty(result.browser.version);
  const osName = nonEmpty(result.os.name);
  const version = osName === undefined ? undefined : osVersion(ua, osName, nonEmpty(result.os.version), nonEmpty(result.os.versionName));
  const platformType = result.platform.type;
  const vendor = nonEmpty(result.platform.vendor);
  const model = nonEmpty(result.platform.model);
  return {
    ...(browserName === undefined ? {} : { browser: { name: browserName, ...(browserVersion === undefined ? {} : { version: browserVersion }) } }),
    ...(osName === undefined ? {} : { os: { name: osName, ...(version === undefined ? {} : { version }) } }),
    ...(isDeviceClass(platformType) ? { type: platformType } : {}),
    // A crawler's "vendor" is its operator (Google, Bing), not a device maker.
    ...(vendor === undefined || platformType === 'bot' ? {} : { vendor }),
    ...(model === undefined ? {} : { model }),
    bot: platformType === 'bot' || isbot(ua)
  };
};

/** The `ua` module with full User-Agent parsing (`bowserParser`), to use in place of the built-in `uaModule`. */
export const uaModuleWithBowser: EdgeModule = createUaModule({ parser: bowserParser });
