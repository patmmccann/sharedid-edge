import { createHandler, readConsent, resolveConfig, type PayloadV1, type SharedIdEdgeHandler } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { bowserParser, uaModuleWithBowser } from '../src/bowser.js';
import {
  botParser,
  createUaModule,
  deviceType,
  highEntropyDenial,
  hintOsVersion,
  isGreaseBrand,
  parseBooleanHeader,
  parseBrandList,
  parseStringHeader,
  readClientHints,
  uaDevice,
  uaModule,
  uaSettings,
  versionComponents
} from '../src/index.js';
import { UA, type UaName } from './corpus.js';

const CHROME_WINDOWS_HINTS = {
  'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"'
};
const CHROME_WINDOWS_HIGH = {
  ...CHROME_WINDOWS_HINTS,
  'Sec-CH-UA-Full-Version-List': '"Google Chrome";v="131.0.6778.86", "Chromium";v="131.0.6778.86", "Not_A Brand";v="24.0.0.0"',
  'Sec-CH-UA-Platform-Version': '"15.0.0"',
  'Sec-CH-UA-Arch': '"x86"',
  'Sec-CH-UA-Bitness': '"64"',
  'Sec-CH-UA-Model': '""'
};
const CHROME_ANDROID_HIGH = {
  'Sec-CH-UA': '"Chromium";v="131", "Not A(Brand";v="8", "Google Chrome";v="131"',
  'Sec-CH-UA-Mobile': '?1',
  'Sec-CH-UA-Platform': '"Android"',
  'Sec-CH-UA-Full-Version-List': '"Chromium";v="131.0.6778.81", "Not A(Brand";v="8.0.0.0", "Google Chrome";v="131.0.6778.81"',
  'Sec-CH-UA-Platform-Version': '"14.0.0"',
  'Sec-CH-UA-Model': '"Pixel 8"'
};

const hints = (headers: Record<string, string>): ReturnType<typeof readClientHints> => readClientHints(new Headers(headers));

describe('isGreaseBrand', () => {
  it.each(['Not A(Brand', 'Not)A;Brand', 'Not_A Brand', ' Not;A Brand', '(Not(A:Brand', 'Not/A)Brand', 'Not.A/Brand', 'Not:A-Brand', 'Not?A_Brand', 'Not=A?Brand', 'Not;A=Brand', 'Not-A.Brand'])(
    '%j is GREASE', brand => {
      expect(isGreaseBrand(brand)).toBe(true);
    }
  );
  it.each(['Google Chrome', 'Chromium', 'Microsoft Edge', 'Opera', 'Brave', 'Not A Browser', 'NotABrand', 'Android WebView'])('%j is a real brand', brand => {
    expect(isGreaseBrand(brand)).toBe(false);
  });
});

describe('parseBrandList', () => {
  it('reads brands and versions, dropping GREASE', () => {
    expect(parseBrandList(CHROME_WINDOWS_HINTS['Sec-CH-UA'])).toEqual([
      { brand: 'Google Chrome', version: '131' },
      { brand: 'Chromium', version: '131' }
    ]);
    expect(parseBrandList(CHROME_ANDROID_HIGH['Sec-CH-UA-Full-Version-List'])).toEqual([
      { brand: 'Chromium', version: '131.0.6778.81' },
      { brand: 'Google Chrome', version: '131.0.6778.81' }
    ]);
  });
  it('handles escapes, spacing, other parameters and an empty header', () => {
    expect(parseBrandList(String.raw`"A \"quoted\" \\ brand";v="1"`)).toEqual([{ brand: String.raw`A "quoted" \ brand`, version: '1' }]);
    expect(parseBrandList('"Edge";v="131",  "Chromium" ; v="131"')).toBeUndefined();
    expect(parseBrandList('"Edge";v="131",\t"Chromium";x;v="130";y=1')).toEqual([{ brand: 'Edge', version: '131' }, { brand: 'Chromium', version: '130' }]);
    expect(parseBrandList('')).toEqual([]);
  });
  it('leaves out brands without a string version', () => {
    expect(parseBrandList('"Chromium", "Edge";v=131, "Opera";v="114"')).toEqual([{ brand: 'Opera', version: '114' }]);
  });
  it('rejects malformed lists as a whole', () => {
    for (const header of ['Chromium;v="131"', '"Chromium;v="131"', '"Chromium";v="131",', '"Chromium";v="131" "Edge";v="131"', '"Chrömium";v="1"', '"a";v="1",,"b";v="2"', '"Chromium";="131"', 'x'.repeat(2000)]) {
      expect(parseBrandList(header)).toBeUndefined();
    }
  });
  it('keeps at most eight brands', () => {
    const header = Array.from({ length: 20 }, (_, i) => `"Brand${String(i)}";v="1"`).join(', ');
    expect(parseBrandList(header)).toHaveLength(8);
  });
});

describe('single-value hints', () => {
  it('reads strings', () => {
    expect(parseStringHeader('"Windows"')).toBe('Windows');
    expect(parseStringHeader(' "Chrome OS" ')).toBe('Chrome OS');
    expect(parseStringHeader('""')).toBeUndefined();
    expect(parseStringHeader('Windows')).toBeUndefined();
    expect(parseStringHeader('"Windows" "macOS"')).toBeUndefined();
    expect(parseStringHeader(`"${'x'.repeat(65)}"`)).toBeUndefined();
  });
  it('reads booleans', () => {
    expect(parseBooleanHeader('?1')).toBe(true);
    expect(parseBooleanHeader('?0')).toBe(false);
    for (const value of ['1', 'true', '?2', '', '?1;a']) expect(parseBooleanHeader(value)).toBeUndefined();
  });
});

describe('readClientHints', () => {
  it('reads every hint', () => {
    expect(hints(CHROME_WINDOWS_HIGH)).toEqual({
      brands: [{ brand: 'Google Chrome', version: '131' }, { brand: 'Chromium', version: '131' }],
      mobile: false,
      platform: 'Windows',
      fullVersionList: [{ brand: 'Google Chrome', version: '131.0.6778.86' }, { brand: 'Chromium', version: '131.0.6778.86' }],
      platformVersion: '15.0.0',
      architecture: 'x86',
      bitness: '64'
    });
  });
  it('is empty without hints, and drops malformed ones and Unknown', () => {
    expect(hints({})).toEqual({});
    expect(hints({ 'Sec-CH-UA': 'Chrome', 'Sec-CH-UA-Mobile': 'yes', 'Sec-CH-UA-Platform': '"Unknown"', 'Sec-CH-UA-Model': 'Pixel' })).toEqual({});
    expect(hints({ 'Sec-CH-UA': '"Not A(Brand";v="99"' })).toEqual({});
  });
});

describe('versions', () => {
  it('splits dotted versions', () => {
    expect(versionComponents('131.0.6778.86')).toEqual(['131', '0', '6778', '86']);
    expect(versionComponents('14')).toEqual(['14']);
    for (const v of [undefined, '', '1.', 'v1', '1..2', 'NT 10.0', '1.2.3.4.5.6.7']) expect(versionComponents(v)).toBeUndefined();
  });
  it('maps the Windows platform version to the release', () => {
    expect(hintOsVersion('Windows', '15.0.0')).toBe('11');
    expect(hintOsVersion('Windows', '13.0.0')).toBe('11');
    expect(hintOsVersion('Windows', '10.0.0')).toBe('10');
    expect(hintOsVersion('Windows', '1.0.0')).toBe('10');
    expect(hintOsVersion('Windows', '0.3.0')).toBeUndefined();
    expect(hintOsVersion('macOS', '14.5.0')).toBe('14.5.0');
    expect(hintOsVersion('Android', '14.0.0')).toBe('14.0.0');
    expect(hintOsVersion('Android', 'fourteen')).toBeUndefined();
  });
});

describe('uaSettings', () => {
  it('defaults ua to false', () => {
    expect(uaSettings({})).toEqual({ ua: false });
    expect(uaSettings({ ua: true })).toEqual({ ua: true });
  });
  it('reads the parser', () => {
    expect(uaSettings({})).toEqual({ ua: false });
    expect(uaSettings({ parser: 'bowser' })).toEqual({ ua: false, parser: 'bowser' });
    expect(uaSettings({ parser: 'isbot', ua: true })).toEqual({ ua: true, parser: 'isbot' });
    for (const parser of ['Bowser', 'ua-parser-js', true, '']) expect(() => uaSettings({ parser })).toThrow(TypeError);
  });
  it('rejects unknown keys and wrong types', () => {
    for (const config of [{ ua: 'true' }, { ua: 1 }, { ua: null }, { acceptCh: true }, { UA: true }]) expect(() => uaSettings(config)).toThrow(TypeError);
  });
});

describe('highEntropyDenial', () => {
  const consent = (query: string, headers: Record<string, string> = {}, isEU?: boolean): ReturnType<typeof readConsent> =>
    readConsent(new URL(`https://www.example.com/_sid/v1${query}`), new Headers(headers), new Map(), isEU === undefined ? {} : { isEU });
  it('allows high-entropy data without restrictions, or with a valid TC string', () => {
    expect(highEntropyDenial(consent(''))).toBeUndefined();
    expect(highEntropyDenial(consent('?gdpr=1&gdpr_consent=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))).toBeUndefined();
    expect(highEntropyDenial(consent('?us_privacy=1YNN'))).toBeUndefined();
  });
  it('denies it with GPC, COPPA, a US privacy opt-out, an invalid TC string, or GDPR without one', () => {
    expect(highEntropyDenial(consent('', { 'Sec-GPC': '1' }))).toBe('gpc');
    expect(highEntropyDenial(consent('?coppa=1'))).toBe('coppa');
    expect(highEntropyDenial(consent('?us_privacy=1YYN'))).toBe('us-privacy');
    expect(highEntropyDenial(consent('?gdpr_consent=bad'))).toBe('tcf: invalid TC string');
    expect(highEntropyDenial(consent('?gdpr=1'))).toBe('tcf: no TC string');
    expect(highEntropyDenial(consent('', {}, true))).toBe('tcf: no TC string');
  });
});

describe('bowserParser on real User-Agents', () => {
  const cases: [UaName, ReturnType<typeof bowserParser>][] = [
    ['chromeWindows', { browser: { name: 'Chrome', version: '131.0.0.0' }, os: { name: 'Windows' }, type: 'desktop', bot: false }],
    ['chromeMac', { browser: { name: 'Chrome', version: '131.0.0.0' }, os: { name: 'macOS' }, type: 'desktop', vendor: 'Apple', bot: false }],
    ['chromeAndroidReduced', { browser: { name: 'Chrome', version: '131.0.0.0' }, os: { name: 'Android' }, type: 'mobile', bot: false }],
    ['chromeAndroidTabletReduced', { browser: { name: 'Chrome', version: '131.0.0.0' }, os: { name: 'Android' }, type: 'tablet', bot: false }],
    ['firefoxAndroid', { browser: { name: 'Firefox', version: '133.0' }, os: { name: 'Android', version: '14' }, type: 'mobile', bot: false }],
    ['safariIphone', { browser: { name: 'Safari', version: '18.1' }, os: { name: 'iOS', version: '18.1' }, type: 'mobile', vendor: 'Apple', model: 'iPhone', bot: false }],
    ['safariIpad', { browser: { name: 'Safari', version: '17.6' }, os: { name: 'iOS', version: '17.6' }, type: 'tablet', vendor: 'Apple', model: 'iPad', bot: false }],
    // iPadOS asks for desktop sites with a Mac's User-Agent; nothing in it tells them apart.
    ['safariIpadDesktopMode', { browser: { name: 'Safari', version: '18.1' }, os: { name: 'macOS' }, type: 'desktop', vendor: 'Apple', bot: false }],
    ['androidWebView', { browser: { name: 'Chrome', version: '127.0.6533.103' }, os: { name: 'Android', version: '14' }, type: 'mobile', bot: false }],
    ['samsungTizenTv', { browser: { name: 'Tizen' }, os: { name: 'Tizen', version: '6.5' }, type: 'tv', bot: false }],
    ['lgWebOsTv', { browser: { name: 'WebOS Browser' }, os: { name: 'WebOS' }, type: 'tv', bot: false }],
    ['rokuTv', { browser: { name: 'Roku', version: 'DVP-12.5' }, os: { name: 'Roku', version: '12.5' }, type: 'tv', bot: false }],
    // Bowser reports a Fire TV as an Android phone and knows nothing of an Apple TV: both are set-top boxes.
    ['fireTvStick', { browser: { name: 'Chrome', version: '119.0.6045.193' }, os: { name: 'Android', version: '9' }, type: 'set-top-box', vendor: 'Amazon', model: 'AFTKA', bot: false }],
    ['appleTv', { browser: { name: 'AppleCoreMedia', version: '1.0.0.21J354' }, type: 'set-top-box', vendor: 'Apple', model: 'Apple TV', bot: false }],
    ['googlebot', { browser: { name: 'Googlebot', version: '2.1' }, bot: true }],
    ['bingbot', { browser: { name: 'BingCrawler', version: '2.0' }, bot: true }],
    ['slackbot', { browser: { name: 'SlackBot', version: '1.0' }, bot: true }],
    ['facebookexternalhit', { browser: { name: 'FacebookExternalHit' }, bot: true }],
    ['twitterbot', { bot: true }]
  ];
  it.each(cases)('%s', (name, expected) => {
    expect(bowserParser(UA[name])).toEqual(expected);
  });
  it('keeps the Windows release for older versions, and isn\'t fooled by a long User-Agent', () => {
    expect(bowserParser('Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36').os).toEqual({ name: 'Windows', version: '7' });
    expect(bowserParser(`${UA.safariIphone} ${'x'.repeat(10_000)} Googlebot`).bot).toBe(false);
  });
});

describe('botParser', () => {
  it('flags declared crawlers, link previewers and automated clients, and nothing else', () => {
    const bots: UaName[] = ['googlebot', 'googlebotSmartphone', 'bingbot', 'slackbot', 'facebookexternalhit', 'twitterbot', 'gptbot', 'curl', 'headlessChrome'];
    for (const [name, ua] of Object.entries(UA)) expect(botParser(ua), name).toEqual({ bot: bots.includes(name as UaName) });
  });
});

describe('deviceType', () => {
  const none = { bot: false };
  it('maps the parser\'s device class to OpenRTB device types', () => {
    expect(deviceType({}, { ...none, type: 'mobile' })).toBe(4);
    expect(deviceType({}, { ...none, type: 'tablet' })).toBe(5);
    expect(deviceType({}, { ...none, type: 'tv' })).toBe(3);
    expect(deviceType({}, { ...none, type: 'set-top-box' })).toBe(7);
    expect(deviceType({}, { ...none, type: 'desktop' })).toBe(2);
    expect(deviceType({}, none)).toBeUndefined();
  });
  it('prefers the mobile hint, keeping tablets', () => {
    expect(deviceType({ mobile: true }, none)).toBe(4);
    expect(deviceType({ mobile: true }, { ...none, type: 'tablet' })).toBe(5);
    expect(deviceType({ mobile: false, platform: 'Windows' }, { ...none, type: 'mobile' })).toBe(2);
    expect(deviceType({ mobile: false, platform: 'Android' }, { ...none, type: 'tablet' })).toBe(5);
    expect(deviceType({ mobile: false, platform: 'Android' }, none)).toBeUndefined();
  });
  it('treats a desktop OS as a personal computer', () => {
    expect(deviceType({ platform: 'Chrome OS' }, none)).toBe(2);
    expect(deviceType({}, { ...none, os: { name: 'Chrome OS' } })).toBe(2);
    expect(deviceType({}, { ...none, os: { name: 'Linux' } })).toBe(2);
    expect(deviceType({}, { ...none, os: { name: 'iOS' } })).toBeUndefined();
  });
});

describe('uaDevice', () => {
  const full = { highEntropy: true, includeUa: false, parser: bowserParser } as const;
  const limited = { highEntropy: false, includeUa: false, parser: bowserParser } as const;

  it('Chrome with high-entropy hints: sua source 2, full versions, Windows 11', () => {
    expect(uaDevice(hints(CHROME_WINDOWS_HIGH), UA.chromeWindows, full)).toEqual({
      sua: {
        browsers: [{ brand: 'Google Chrome', version: ['131', '0', '6778', '86'] }, { brand: 'Chromium', version: ['131', '0', '6778', '86'] }],
        platform: { brand: 'Windows', version: ['15', '0', '0'] },
        mobile: 0,
        architecture: 'x86',
        bitness: '64',
        source: 2
      },
      devicetype: 2,
      os: 'Windows',
      osv: '11'
    });
  });
  it('Chrome with the default hints only: sua source 1, major versions, no OS version from the frozen UA', () => {
    expect(uaDevice(hints(CHROME_WINDOWS_HINTS), UA.chromeWindows, full)).toEqual({
      sua: { browsers: [{ brand: 'Google Chrome', version: ['131'] }, { brand: 'Chromium', version: ['131'] }], platform: { brand: 'Windows' }, mobile: 0, source: 1 },
      devicetype: 2,
      os: 'Windows'
    });
  });
  it('Chrome on Android: the model hint, and phone', () => {
    expect(uaDevice(hints(CHROME_ANDROID_HIGH), UA.chromeAndroidReduced, full)).toEqual({
      sua: {
        browsers: [{ brand: 'Chromium', version: ['131', '0', '6778', '81'] }, { brand: 'Google Chrome', version: ['131', '0', '6778', '81'] }],
        platform: { brand: 'Android', version: ['14', '0', '0'] },
        mobile: 1,
        model: 'Pixel 8',
        source: 2
      },
      devicetype: 4,
      model: 'Pixel 8',
      os: 'Android',
      osv: '14.0.0'
    });
  });
  it('Safari without hints: sua source 3 from the User-Agent', () => {
    expect(uaDevice({}, UA.safariIphone, full)).toEqual({
      sua: { browsers: [{ brand: 'Safari', version: ['18', '1'] }], platform: { brand: 'iOS', version: ['18', '1'] }, mobile: 1, source: 3 },
      devicetype: 4,
      make: 'Apple',
      model: 'iPhone',
      os: 'iOS',
      osv: '18.1'
    });
  });
  it('uses only the major version from Chromium\'s reduced User-Agent', () => {
    expect(uaDevice({}, UA.chromeAndroidReduced, full)?.sua).toEqual({ browsers: [{ brand: 'Chrome', version: ['131'] }], platform: { brand: 'Android' }, mobile: 1, source: 3 });
  });
  it('reports a smart TV as a connected TV', () => {
    expect(uaDevice({}, UA.samsungTizenTv, full)).toMatchObject({ devicetype: 3, os: 'Tizen', osv: '6.5' });
  });
  it('reports the iPadOS desktop-mode User-Agent as the Mac it claims to be', () => {
    expect(uaDevice({}, UA.safariIpadDesktopMode, full)).toMatchObject({ devicetype: 2, os: 'macOS', make: 'Apple' });
  });
  it('adds the traffic signal for a crawler', () => {
    expect(uaDevice({}, UA.googlebot, full)).toEqual({
      sua: { browsers: [{ brand: 'Googlebot', version: ['2', '1'] }], source: 3 },
      ext: { traffic: { bot: true, botKind: 'declared', sources: ['ua'] } }
    });
    expect(uaDevice({}, UA.slackbot, { highEntropy: true, includeUa: false })).toEqual({ ext: { traffic: { bot: true, botKind: 'declared', sources: ['ua'] } } });
    expect(uaDevice({}, UA.safariIphone, { highEntropy: true, includeUa: false })).toBeUndefined();
  });
  it('sends only low-entropy fields when consent limits it, but always the traffic signal', () => {
    expect(uaDevice(hints(CHROME_ANDROID_HIGH), UA.chromeAndroidReduced, limited)).toEqual({
      sua: { browsers: [{ brand: 'Chromium', version: ['131'] }, { brand: 'Google Chrome', version: ['131'] }], platform: { brand: 'Android' }, mobile: 1, source: 1 },
      devicetype: 4,
      os: 'Android'
    });
    expect(uaDevice({}, UA.safariIphone, limited)).toEqual({
      sua: { browsers: [{ brand: 'Safari', version: ['18'] }], platform: { brand: 'iOS' }, mobile: 1, source: 3 },
      devicetype: 4,
      make: 'Apple',
      os: 'iOS'
    });
    expect(uaDevice({}, UA.googlebotSmartphone, limited)?.ext).toEqual({ traffic: { bot: true, botKind: 'declared', sources: ['ua'] } });
  });
  it('includes the raw User-Agent only when enabled and consent allows high-entropy data', () => {
    expect(uaDevice({}, UA.safariIphone, { ...full, includeUa: true })?.ua).toBe(UA.safariIphone);
    expect(uaDevice({}, UA.safariIphone, { ...limited, includeUa: true })?.ua).toBeUndefined();
  });
  it('doesn\'t mix the parser\'s OS version into a different hinted OS', () => {
    expect(uaDevice({ platform: 'Linux' }, UA.safariIphone, full)).toMatchObject({ os: 'Linux' });
    expect(uaDevice({ platform: 'Linux' }, UA.safariIphone, full)?.osv).toBeUndefined();
  });
  it('returns nothing without a User-Agent or hints', () => {
    expect(uaDevice({}, undefined, full)).toBeUndefined();
  });
});

describe('the ua module in the handler', () => {
  const handler = (env: Record<string, string>, module = uaModule): SharedIdEdgeHandler => createHandler({ config: resolveConfig(env), modules: [module] });
  const payload = async (env: Record<string, string>, path: string, headers: Record<string, string>, module = uaModule): Promise<PayloadV1> =>
    await (await handler(env, module)(new Request(`https://www.example.com${path}`, { headers }), {})).json() as PayloadV1;
  const chrome = { 'User-Agent': UA.chromeAndroidReduced, ...CHROME_ANDROID_HIGH };

  it('does nothing unless listed in SID_MODULES', async () => {
    const body = await payload({}, '/_sid/v1', chrome);
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules).toEqual({});
  });
  it('adds device data from Client Hints', async () => {
    const body = await payload({ SID_MODULES: 'ua' }, '/_sid/v1', chrome);
    expect(body.ortb2).toEqual({
      device: {
        sua: {
          browsers: [{ brand: 'Chromium', version: ['131', '0', '6778', '81'] }, { brand: 'Google Chrome', version: ['131', '0', '6778', '81'] }],
          platform: { brand: 'Android', version: ['14', '0', '0'] },
          mobile: 1,
          model: 'Pixel 8',
          source: 2
        },
        devicetype: 4,
        model: 'Pixel 8',
        os: 'Android',
        osv: '14.0.0'
      }
    });
    expect(body.ext.modules['ua']?.status).toBe('ok');
  });
  it('is empty for a browser without hints, with the built-in parser', async () => {
    const body = await payload({ SID_MODULES: 'ua' }, '/_sid/v1', { 'User-Agent': UA.safariIphone });
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules['ua']?.status).toBe('empty');
  });
  it('parses the User-Agent with Bowser when built in and the parser setting asks for it', async () => {
    const bowser = { SID_MODULES: 'ua', SID_MODULE_CONFIG: '{"ua":{"parser":"bowser"}}' };
    const body = await payload(bowser, '/_sid/v1', { 'User-Agent': UA.safariIphone }, uaModuleWithBowser);
    expect(body.ortb2).toMatchObject({ device: { devicetype: 4, os: 'iOS', osv: '18.1', make: 'Apple', model: 'iPhone', sua: { source: 3 } } });
    expect(body.ext.modules['ua']?.status).toBe('ok');
  });
  it('keeps the built-in parser in a build with Bowser until the setting asks for it', async () => {
    for (const config of ['{}', '{"ua":{"parser":"isbot"}}']) {
      const body = await payload({ SID_MODULES: 'ua', SID_MODULE_CONFIG: config }, '/_sid/v1', { 'User-Agent': UA.safariIphone }, uaModuleWithBowser);
      expect(body.ortb2, config).toBeUndefined();
      expect(body.ext.modules['ua']?.status, config).toBe('empty');
    }
  });
  it('reports an error when the setting asks for Bowser and the build doesn\'t have it', async () => {
    const body = await payload({ SID_MODULES: 'ua', SID_MODULE_CONFIG: '{"ua":{"parser":"bowser"}}' }, '/_sid/v1', { 'User-Agent': UA.googlebot });
    expect(body.ortb2).toBeUndefined();
    expect(body.ext.modules['ua']?.status).toBe('error');
  });
  it('accepts any parser', async () => {
    const module = createUaModule({ parser: () => ({ bot: false, type: 'tv', os: { name: 'Roku' } }) });
    const body = await payload({ SID_MODULES: 'ua' }, '/_sid/v1', { 'User-Agent': 'anything' }, module);
    expect(body.ortb2).toEqual({ device: { sua: { platform: { brand: 'Roku' }, mobile: 0, source: 3 }, devicetype: 3, os: 'Roku' } });
  });
  it('flags a crawler, with GPC and COPPA too', async () => {
    for (const [path, headers] of [['/_sid/v1', {}], ['/_sid/v1', { 'Sec-GPC': '1' }], ['/_sid/v1?coppa=1', {}]] as const) {
      const body = await payload({ SID_MODULES: 'ua' }, path, { 'User-Agent': UA.bingbot, ...headers });
      expect(body.ortb2).toEqual({ device: { ext: { traffic: { bot: true, botKind: 'declared', sources: ['ua'] } } } });
    }
  });
  it('leaves out high-entropy fields when consent limits them', async () => {
    for (const [path, headers] of [
      ['/_sid/v1', { 'Sec-GPC': '1' }],
      ['/_sid/v1?coppa=1', {}],
      ['/_sid/v1?us_privacy=1YYN', {}],
      ['/_sid/v1?gdpr=1', {}],
      ['/_sid/v1?gdpr_consent=invalid', {}]
    ] as const) {
      const body = await payload({ SID_MODULES: 'ua', SID_MODULE_CONFIG: '{"ua":{"ua":true}}' }, path, { ...chrome, ...headers });
      expect(body.ortb2, path).toEqual({
        device: {
          sua: { browsers: [{ brand: 'Chromium', version: ['131'] }, { brand: 'Google Chrome', version: ['131'] }], platform: { brand: 'Android' }, mobile: 1, source: 1 },
          devicetype: 4,
          os: 'Android'
        }
      });
    }
  });
  it('adds device.ua when enabled', async () => {
    const body = await payload({ SID_MODULES: 'ua', SID_MODULE_CONFIG: '{"ua":{"ua":true}}' }, '/_sid/v1', chrome);
    expect(body.ortb2).toMatchObject({ device: { ua: UA.chromeAndroidReduced } });
  });
  it('ignores the User-Agent CloudFront substitutes when it isn\'t forwarded', async () => {
    const body = await payload({ SID_MODULES: 'ua' }, '/_sid/v1', { 'User-Agent': 'Amazon CloudFront' });
    expect(body.ext.modules['ua']?.status).toBe('empty');
  });
  it('reports an error, and adds nothing, for an invalid setting', async () => {
    for (const config of ['{"ua":{"ua":"yes"}}', '{"ua":{"acceptCh":true}}']) {
      const body = await payload({ SID_MODULES: 'ua', SID_MODULE_CONFIG: config }, '/_sid/v1', chrome);
      expect(body.ortb2).toBeUndefined();
      expect(body.ext.modules['ua']?.status).toBe('error');
    }
  });
  it('merges with other device fields', async () => {
    const ip = { name: 'ip', run: () => ({ ortb2: { device: { ip: '192.0.2.77' } } }) };
    const response = await createHandler({ config: resolveConfig({ SID_MODULES: 'ip,ua' }), modules: [ip, uaModule] })(
      new Request('https://www.example.com/_sid/v1', { headers: { 'User-Agent': UA.googlebot } }),
      {}
    );
    expect(((await response.json()) as PayloadV1).ortb2).toEqual({ device: { ip: '192.0.2.77', ext: { traffic: { bot: true, botKind: 'declared', sources: ['ua'] } } } });
  });
});

describe('the Bowser option (parser "bowser")', () => {
  const env = { SID_MODULES: 'ua', SID_MODULE_CONFIG: '{"ua":{"parser":"bowser","ua":true}}' };
  const device = async (headers: Record<string, string>, path = '/_sid/v1'): Promise<unknown> => {
    const response = await createHandler({ config: resolveConfig(env), modules: [uaModuleWithBowser] })(new Request(`https://www.example.com${path}`, { headers }), {});
    return ((await response.json()) as PayloadV1).ortb2?.['device'];
  };
  const browser = (brand: string, ...version: string[]): { brand: string; version: string[] } => ({ brand, version });

  it.each<[UaName, Record<string, unknown>]>([
    ['safariIphone', {
      sua: { browsers: [browser('Safari', '18', '1')], platform: browser('iOS', '18', '1'), mobile: 1, source: 3 },
      devicetype: 4, make: 'Apple', model: 'iPhone', os: 'iOS', osv: '18.1'
    }],
    ['safariIpad', {
      sua: { browsers: [browser('Safari', '17', '6')], platform: browser('iOS', '17', '6'), mobile: 0, source: 3 },
      devicetype: 5, make: 'Apple', model: 'iPad', os: 'iOS', osv: '17.6'
    }],
    ['firefoxAndroid', {
      sua: { browsers: [browser('Firefox', '133', '0')], platform: browser('Android', '14'), mobile: 1, source: 3 },
      devicetype: 4, os: 'Android', osv: '14'
    }],
    ['samsungTizenTv', {
      sua: { browsers: [{ brand: 'Tizen' }], platform: browser('Tizen', '6', '5'), mobile: 0, source: 3 },
      devicetype: 3, os: 'Tizen', osv: '6.5'
    }],
    ['fireTvStick', {
      sua: { browsers: [browser('Chrome', '119', '0', '6045', '193')], platform: browser('Android', '9'), mobile: 0, source: 3 },
      devicetype: 7, make: 'Amazon', model: 'AFTKA', os: 'Android', osv: '9'
    }],
    // macOS is frozen at 10.15.7 in the User-Agent, so there's no osv.
    ['safariMac', {
      sua: { browsers: [browser('Safari', '18', '1')], platform: { brand: 'macOS' }, mobile: 0, source: 3 },
      devicetype: 2, make: 'Apple', os: 'macOS'
    }],
    // Chrome without hints (a request that didn't carry them): the reduced version is only the major one, and
    // Windows NT 10.0 is either 10 or 11.
    ['chromeWindows', {
      sua: { browsers: [browser('Chrome', '131')], platform: { brand: 'Windows' }, mobile: 0, source: 3 },
      devicetype: 2, os: 'Windows'
    }],
    ['chromeMac', {
      sua: { browsers: [browser('Chrome', '131')], platform: { brand: 'macOS' }, mobile: 0, source: 3 },
      devicetype: 2, make: 'Apple', os: 'macOS'
    }]
  ])('%s: every field Bowser can give', async (name, expected) => {
    expect(await device({ 'User-Agent': UA[name] })).toEqual({ ua: UA[name], ...expected });
  });

  it('prefers Client Hints: sua, os and osv from the hints, make from the User-Agent', async () => {
    expect(await device({ 'User-Agent': UA.chromeMac, 'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131"', 'Sec-CH-UA-Mobile': '?0', 'Sec-CH-UA-Platform': '"macOS"', 'Sec-CH-UA-Platform-Version': '"15.1.0"' })).toEqual({
      ua: UA.chromeMac,
      sua: { browsers: [browser('Google Chrome', '131'), browser('Chromium', '131')], platform: browser('macOS', '15', '1', '0'), mobile: 0, source: 2 },
      devicetype: 2,
      make: 'Apple',
      os: 'macOS',
      osv: '15.1.0'
    });
  });
  it('prefers the model hint, and keeps a tablet the User-Agent reports under the mobile hint', async () => {
    expect(await device({ 'User-Agent': UA.samsungTablet, 'Sec-CH-UA-Mobile': '?1', 'Sec-CH-UA-Platform': '"Android"', 'Sec-CH-UA-Model': '"SM-X710"' })).toMatchObject({
      sua: { platform: { brand: 'Android' }, mobile: 1, model: 'SM-X710', source: 2 },
      devicetype: 5,
      model: 'SM-X710',
      os: 'Android',
      osv: '13'
    });
  });
  it('sends only low-entropy fields when consent limits them: no model, osv, full versions or ua', async () => {
    for (const [path, headers] of [['/_sid/v1', { 'Sec-GPC': '1' }], ['/_sid/v1?coppa=1', {}], ['/_sid/v1?us_privacy=1YYN', {}], ['/_sid/v1?gdpr=1', {}], ['/_sid/v1?gdpr_consent=invalid', {}]] as const) {
      expect(await device({ 'User-Agent': UA.safariIpad, ...headers }, path), path).toEqual({
        sua: { browsers: [browser('Safari', '17')], platform: { brand: 'iOS' }, mobile: 0, source: 3 },
        devicetype: 5,
        make: 'Apple',
        os: 'iOS'
      });
    }
    expect(await device({ 'User-Agent': UA.fireTvStick, 'Sec-GPC': '1' })).toEqual({
      sua: { browsers: [browser('Chrome', '119')], platform: { brand: 'Android' }, mobile: 0, source: 3 },
      devicetype: 7,
      make: 'Amazon',
      os: 'Android'
    });
  });
  it('keeps the traffic signal for crawlers, whatever the consent', async () => {
    expect(await device({ 'User-Agent': UA.googlebot, 'Sec-GPC': '1' })).toEqual({
      sua: { browsers: [browser('Googlebot', '2')], source: 3 },
      ext: { traffic: { bot: true, botKind: 'declared', sources: ['ua'] } }
    });
  });
  it('gives each User-Agent in the corpus a device without throwing', async () => {
    for (const [name, ua] of Object.entries(UA)) expect(await device({ 'User-Agent': ua }), name).toBeDefined();
  });
});
