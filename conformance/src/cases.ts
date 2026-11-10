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
    /** The JSON body contains these values: objects match on the listed keys only, recursively; arrays and scalars exactly. */
    readonly jsonIncludes?: unknown;
    /** Dot-separated paths of object keys the JSON body must not have, e.g. `ortb2.device.geo.lat`. */
    readonly jsonAbsent?: readonly string[];
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

type Check = (value: unknown) => boolean;

const isString: Check = v => typeof v === 'string';
const isBoolean: Check = v => typeof v === 'boolean';
const isInteger: Check = v => Number.isInteger(v);
const isStringArray: Check = v => Array.isArray(v) && v.every(isString);
const isStringRecord: Check = v => isObject(v) && Object.values(v).every(isString);
const isAnything: Check = () => true;

/** Each field the schema allows, with the type check it must pass. Keep in step with case-file.schema.json. */
const REQUEST_FIELDS: Readonly<Record<string, Check>> = {
  method: isString,
  path: v => isString(v) && (v as string).startsWith('/'),
  headers: isStringRecord
};
const EXPECT_FIELDS: Readonly<Record<string, Check>> = {
  status: isInteger,
  headers: isStringRecord,
  absentHeaders: isStringArray,
  bodyLength: isInteger,
  json: isAnything,
  jsonIncludes: isAnything,
  jsonAbsent: isStringArray,
  cookies: v => Array.isArray(v),
  onlyListedCookies: isBoolean,
  noCookies: isBoolean
};
const COOKIE_FIELDS: Readonly<Record<string, Check>> = {
  name: isString,
  value: isString,
  valuePattern: isString,
  maxAge: isInteger,
  sameSite: v => v === 'Lax' || v === 'Strict' || v === 'None',
  path: isString,
  domain: isString,
  httpOnly: isBoolean
};

/** Fails on unknown keys, missing required keys and values of the wrong type. */
function checkFields(file: string, where: string, value: unknown, fields: Readonly<Record<string, Check>>, required: readonly string[]): void {
  if (!isObject(value)) fail(file, `${where} must be an object`);
  for (const key of required) if (!(key in value)) fail(file, `${where}.${key} is required`);
  for (const [key, field] of Object.entries(value)) {
    const check = fields[key];
    if (check === undefined) fail(file, `${where} has unknown key "${key}"`);
    if (!check(field)) fail(file, `${where}.${key} has the wrong type or value: ${JSON.stringify(field)}`);
  }
}

/** Checks a case file's shape, so a typo in a fixture fails loudly instead of skipping an assertion. */
export function validateCaseFile(file: string, value: unknown): CaseFile {
  if (!isObject(value)) fail(file, 'must be a JSON object');
  for (const key of Object.keys(value)) if (!['$schema', 'description', 'config', 'cases'].includes(key)) fail(file, `unknown key "${key}"`);
  const { description, config, cases } = value;
  if (typeof description !== 'string') fail(file, '"description" must be a string');
  if (!isStringRecord(config)) fail(file, '"config" must be an object of strings');
  if (!Array.isArray(cases) || cases.length === 0) fail(file, '"cases" must be a non-empty array');
  cases.forEach((c: unknown, i) => {
    const where = `cases[${String(i)}]`;
    checkFields(file, where, c, { name: isString, request: isObject, expect: isObject }, ['name', 'request', 'expect']);
    const { request, expect } = c as Record<string, unknown>;
    checkFields(file, `${where}.request`, request, REQUEST_FIELDS, ['path']);
    checkFields(file, `${where}.expect`, expect, EXPECT_FIELDS, ['status']);
    const cookies = (expect as Record<string, unknown>)['cookies'];
    if (Array.isArray(cookies)) {
      cookies.forEach((cookie: unknown, j) => {
        checkFields(file, `${where}.expect.cookies[${String(j)}]`, cookie, COOKIE_FIELDS, ['name']);
      });
    }
  });
  // Every field has now been checked against the schema.
  return { file, description, config: config as Record<string, string>, cases: cases as Case[] };
}
