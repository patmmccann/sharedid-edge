import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ExpectedCookie {
  readonly name: string;
  readonly value?: string;
  readonly valuePattern?: string;
  readonly maxAge?: number;
  readonly sameSite?: 'Lax' | 'Strict' | 'None';
  readonly path?: string;
  /** The `Domain` attribute; `""` for a host-only cookie (no `Domain`). */
  readonly domain?: string;
  readonly httpOnly?: boolean;
}

export interface Case {
  readonly name: string;
  readonly request: {
    readonly method?: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
  };
  readonly expect: {
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly absentHeaders?: readonly string[];
    readonly bodyLength?: number;
    readonly json?: unknown;
    readonly cookies?: readonly ExpectedCookie[];
    /** No other cookies than those listed may be set. */
    readonly onlyListedCookies?: boolean;
    readonly noCookies?: boolean;
  };
}

export interface CaseFile {
  readonly file: string;
  readonly description: string;
  /** Environment variables the target must be configured with. */
  readonly config: Readonly<Record<string, string>>;
  readonly cases: readonly Case[];
}

export const CASES_DIR: string = join(import.meta.dirname, '..', 'cases');

export async function loadCaseFiles(dir: string = CASES_DIR): Promise<CaseFile[]> {
  const names = (await readdir(dir)).filter(n => n.endsWith('.json')).sort();
  const files: CaseFile[] = [];
  for (const name of names) {
    const parsed: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'));
    files.push(validateCaseFile(name, parsed));
  }
  return files;
}

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(file: string, where: string, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value) || !Object.values(value).every(v => typeof v === 'string')) fail(file, `${where} must be an object of strings`);
  return value as Record<string, string>;
}

/** Checks a case file's shape, so a typo in a fixture fails loudly instead of skipping an assertion. */
export function validateCaseFile(file: string, value: unknown): CaseFile {
  if (!isObject(value)) fail(file, 'must be a JSON object');
  const { description, config, cases } = value;
  if (typeof description !== 'string') fail(file, '"description" must be a string');
  if (!Array.isArray(cases) || cases.length === 0) fail(file, '"cases" must be a non-empty array');
  const known = new Set(['name', 'request', 'expect']);
  const expectKeys = new Set(['status', 'headers', 'absentHeaders', 'bodyLength', 'json', 'cookies', 'onlyListedCookies', 'noCookies']);
  const cookieKeys = new Set(['name', 'value', 'valuePattern', 'maxAge', 'sameSite', 'path', 'domain', 'httpOnly']);
  cases.forEach((c: unknown, i) => {
    const where = `cases[${String(i)}]`;
    if (!isObject(c)) fail(file, `${where} must be an object`);
    for (const key of Object.keys(c)) if (!known.has(key)) fail(file, `${where} has unknown key "${key}"`);
    if (typeof c['name'] !== 'string') fail(file, `${where}.name must be a string`);
    const request = c['request'];
    if (!isObject(request) || typeof request['path'] !== 'string' || !request['path'].startsWith('/')) fail(file, `${where}.request.path must start with /`);
    stringRecord(file, `${where}.request.headers`, request['headers']);
    const expect = c['expect'];
    if (!isObject(expect) || typeof expect['status'] !== 'number') fail(file, `${where}.expect.status must be a number`);
    for (const key of Object.keys(expect)) if (!expectKeys.has(key)) fail(file, `${where}.expect has unknown key "${key}"`);
    stringRecord(file, `${where}.expect.headers`, expect['headers']);
    const cookies = expect['cookies'];
    if (cookies !== undefined) {
      if (!Array.isArray(cookies)) fail(file, `${where}.expect.cookies must be an array`);
      cookies.forEach((cookie: unknown, j) => {
        if (!isObject(cookie) || typeof cookie['name'] !== 'string') fail(file, `${where}.expect.cookies[${String(j)}].name must be a string`);
        for (const key of Object.keys(cookie)) if (!cookieKeys.has(key)) fail(file, `${where}.expect.cookies[${String(j)}] has unknown key "${key}"`);
      });
    }
  });
  return { file, description, config: stringRecord(file, 'config', config), cases: cases as Case[] };
}
