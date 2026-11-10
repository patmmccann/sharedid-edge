import { isbot } from 'isbot';

/** What the module takes from a User-Agent string. Fields the parser doesn't recognize are left out. */
export interface ParsedUserAgent {
  readonly browser?: { readonly name: string; readonly version?: string };
  readonly os?: { readonly name: string; readonly version?: string };
  /** The device class. */
  readonly type?: 'mobile' | 'tablet' | 'desktop' | 'tv';
  readonly vendor?: string;
  readonly model?: string;
  /** The client identifies itself as a crawler, bot or other automated client. */
  readonly bot: boolean;
}

/** Parses a User-Agent string. Must be synchronous, make no network calls, and not throw on any input. */
export type UserAgentParser = (userAgent: string) => ParsedUserAgent;

/** Only this much of a User-Agent is parsed: real ones are far shorter, and it bounds the work per request. */
export const MAX_UA_LENGTH = 512;

/**
 * The built-in parser: only whether the client identifies itself as a bot, with
 * [isbot](https://github.com/omrilotan/isbot). Device data comes from Client Hints. For full User-Agent parsing
 * (browser, OS, device class, maker and model for browsers that send no hints), use `bowserParser` from
 * `@sharedid-edge/module-ua/bowser`.
 */
export const botParser: UserAgentParser = userAgent => ({ bot: isbot(userAgent.slice(0, MAX_UA_LENGTH)) });
