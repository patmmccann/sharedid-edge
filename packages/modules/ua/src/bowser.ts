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
 * Set-top boxes, which Bowser doesn't have as a class: an Apple TV (no OS or device in Bowser) and an Amazon Fire TV,
 * whose Android User-Agent carries a model code starting `AFT` (`Android 9; AFTKA Build/…`) and which Bowser reports
 * as a phone. A Roku is reported as a TV (`tv`): its User-Agent is the same on Roku TVs and on Roku players.
 */
function setTopBox(ua: string): { readonly vendor: string; readonly model: string } | undefined {
  if (/\bApple ?TV\b/i.test(ua)) return { vendor: 'Apple', model: 'Apple TV' };
  const fireTv = /;\s*(AFT[A-Z0-9]{1,16})(?:\s+Build\/|[;)])/.exec(ua)?.[1];
  return fireTv === undefined ? undefined : { vendor: 'Amazon', model: fireTv };
}

/**
 * Full User-Agent parsing with [Bowser](https://github.com/bowser-js/bowser) (browser, OS, device class, maker and
 * model, plus Apple TV and Fire TV as set-top boxes) and [isbot](https://github.com/omrilotan/isbot) (self-identified
 * crawlers and automated clients). Values browsers freeze are left out rather than reported wrong. Adds about 10 KB
 * gzipped to a bundle.
 */
export const bowserParser: UserAgentParser = userAgent => {
  const ua = userAgent.slice(0, MAX_UA_LENGTH);
  const result = Bowser.parse(ua);
  const browserName = nonEmpty(result.browser.name);
  const browserVersion = nonEmpty(result.browser.version);
  const osName = nonEmpty(result.os.name);
  const version = osName === undefined ? undefined : osVersion(ua, osName, nonEmpty(result.os.version), nonEmpty(result.os.versionName));
  const platformType = result.platform.type;
  const box = platformType === 'bot' ? undefined : setTopBox(ua);
  const vendor = box?.vendor ?? nonEmpty(result.platform.vendor);
  const model = box?.model ?? nonEmpty(result.platform.model);
  const type = box === undefined ? (isDeviceClass(platformType) ? platformType : undefined) : 'set-top-box';
  return {
    ...(browserName === undefined ? {} : { browser: { name: browserName, ...(browserVersion === undefined ? {} : { version: browserVersion }) } }),
    ...(osName === undefined ? {} : { os: { name: osName, ...(version === undefined ? {} : { version }) } }),
    ...(type === undefined ? {} : { type }),
    // A crawler's "vendor" is its operator (Google, Bing), not a device maker.
    ...(vendor === undefined || platformType === 'bot' ? {} : { vendor }),
    ...(model === undefined ? {} : { model }),
    bot: platformType === 'bot' || isbot(ua)
  };
};

/**
 * The `ua` module with Bowser built in, to use in place of the built-in `uaModule`: the setting
 * `SID_MODULE_CONFIG={"ua":{"parser":"bowser"}}` then parses the User-Agent with `bowserParser`. Without the setting it
 * behaves exactly like `uaModule`. `@sharedid-edge/modules/bowser` is the built-in list with this module.
 */
export const uaModuleWithBowser: EdgeModule = createUaModule({ bowser: bowserParser });
