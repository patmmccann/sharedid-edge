/** A brand and its version, from `Sec-CH-UA` (major version) or `Sec-CH-UA-Full-Version-List` (full version). */
export interface BrandVersion {
  readonly brand: string;
  readonly version: string;
}

/** The User-Agent Client Hints on a request. Each field is present only when its header was sent and well formed. */
export interface ClientHints {
  /** `Sec-CH-UA`, GREASE brands dropped. Low entropy: sent by default. */
  readonly brands?: readonly BrandVersion[];
  /** `Sec-CH-UA-Mobile`. Low entropy. */
  readonly mobile?: boolean;
  /** `Sec-CH-UA-Platform`, without `Unknown`. Low entropy. */
  readonly platform?: string;
  /** `Sec-CH-UA-Full-Version-List`, GREASE brands dropped. High entropy: sent only when asked for. */
  readonly fullVersionList?: readonly BrandVersion[];
  /** `Sec-CH-UA-Platform-Version`. High entropy. */
  readonly platformVersion?: string;
  /** `Sec-CH-UA-Model`, when not empty (desktops send `""`). High entropy. */
  readonly model?: string;
  /** `Sec-CH-UA-Arch`. High entropy. */
  readonly architecture?: string;
  /** `Sec-CH-UA-Bitness`. High entropy. */
  readonly bitness?: string;
}

/** Longest header value read; longer values are ignored as malformed. */
const MAX_HEADER = 1024;
/** Longest string value kept (a brand, platform, model, …). */
const MAX_VALUE = 64;
/** Most brands kept from a list. Browsers send three or four. */
const MAX_BRANDS = 8;

/**
 * Whether a brand is GREASE: a made-up brand Chromium adds so servers don't depend on an exact list. It's "Not",
 * "A" and "Brand" separated and surrounded by punctuation that varies by version: `Not A(Brand`, `Not)A;Brand`,
 * `Not_A Brand`, ` Not;A Brand`, `(Not(A:Brand`, `Not/A)Brand`, `Not.A/Brand`, …
 */
export function isGreaseBrand(brand: string): boolean {
  return /^[^A-Za-z0-9]*Not[^A-Za-z0-9]+A[^A-Za-z0-9]+Brand[^A-Za-z0-9]*$/i.test(brand);
}

/** A parsed Structured Field string (RFC 8941 sf-string) and where it ended, or undefined if malformed. */
function parseString(input: string, start: number): { value: string; end: number } | undefined {
  if (input[start] !== '"') return undefined;
  let value = '';
  for (let i = start + 1; i < input.length; i++) {
    const char = input[i] ?? '';
    if (char === '\\') {
      const next = input[i + 1];
      if (next !== '"' && next !== '\\') return undefined;
      value += next;
      i++;
    } else if (char === '"') {
      return { value, end: i + 1 };
    } else {
      const code = char.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) return undefined;
      value += char;
    }
  }
  return undefined;
}

function skipSpaces(input: string, i: number): number {
  while (input[i] === ' ' || input[i] === '\t') i++;
  return i;
}

const TOKEN_KEY = /^[a-z*][a-z0-9_\-.*]*/;

/**
 * Parses a brand list (`Sec-CH-UA`, `Sec-CH-UA-Full-Version-List`): an RFC 8941 list of strings, each with a `v`
 * parameter, such as `"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"`. Returns undefined when the
 * header is malformed (RFC 8941 rejects the whole field). Brands without a string `v`, and GREASE brands, are left out.
 */
export function parseBrandList(header: string): BrandVersion[] | undefined {
  if (header.length > MAX_HEADER) return undefined;
  const input = header.trim();
  const brands: BrandVersion[] = [];
  let i = 0;
  while (i < input.length) {
    const brand = parseString(input, i);
    if (brand === undefined) return undefined;
    i = brand.end;
    let version: string | undefined;
    while (input[i] === ';') {
      i = skipSpaces(input, i + 1);
      const key = TOKEN_KEY.exec(input.slice(i))?.[0];
      if (key === undefined) return undefined;
      i += key.length;
      if (input[i] !== '=') continue; // a parameter without a value is boolean true
      i++;
      if (input[i] === '"') {
        const value = parseString(input, i);
        if (value === undefined) return undefined;
        i = value.end;
        if (key === 'v') version = value.value;
      } else {
        // Another bare item (token, number, boolean): skipped, but it must end at a delimiter.
        const bare = /^[^\s;,"]+/.exec(input.slice(i))?.[0];
        if (bare === undefined) return undefined;
        i += bare.length;
      }
    }
    i = skipSpaces(input, i);
    if (i < input.length) {
      if (input[i] !== ',') return undefined;
      i = skipSpaces(input, i + 1);
      if (i >= input.length) return undefined; // a trailing comma
    }
    const name = brand.value.trim();
    if (name !== '' && name.length <= MAX_VALUE && version !== undefined && !isGreaseBrand(name) && brands.length < MAX_BRANDS) {
      brands.push({ brand: name, version: version.trim().slice(0, MAX_VALUE) });
    }
  }
  return brands;
}

/** Parses an RFC 8941 sf-string header (`Sec-CH-UA-Platform: "Windows"`), or undefined if malformed or empty. */
export function parseStringHeader(header: string): string | undefined {
  if (header.length > MAX_HEADER) return undefined;
  const input = header.trim();
  const parsed = parseString(input, 0);
  if (parsed?.end !== input.length) return undefined;
  const value = parsed.value.trim();
  return value === '' || value.length > MAX_VALUE ? undefined : value;
}

/** Parses an RFC 8941 sf-boolean header (`Sec-CH-UA-Mobile: ?1`), or undefined if malformed. */
export function parseBooleanHeader(header: string): boolean | undefined {
  const input = header.trim();
  return input === '?1' ? true : input === '?0' ? false : undefined;
}

/** Reads the User-Agent Client Hints from request headers. Missing and malformed headers are left out. */
export function readClientHints(headers: Headers): ClientHints {
  const read = <T>(name: string, parse: (value: string) => T | undefined): T | undefined => {
    const value = headers.get(name);
    return value === null ? undefined : parse(value);
  };
  const brands = read('Sec-CH-UA', parseBrandList);
  const mobile = read('Sec-CH-UA-Mobile', parseBooleanHeader);
  const platform = read('Sec-CH-UA-Platform', parseStringHeader);
  const fullVersionList = read('Sec-CH-UA-Full-Version-List', parseBrandList);
  const platformVersion = read('Sec-CH-UA-Platform-Version', parseStringHeader);
  const model = read('Sec-CH-UA-Model', parseStringHeader);
  const architecture = read('Sec-CH-UA-Arch', parseStringHeader);
  const bitness = read('Sec-CH-UA-Bitness', parseStringHeader);
  return {
    ...(brands === undefined || brands.length === 0 ? {} : { brands }),
    ...(mobile === undefined ? {} : { mobile }),
    ...(platform === undefined || platform.toLowerCase() === 'unknown' ? {} : { platform }),
    ...(fullVersionList === undefined || fullVersionList.length === 0 ? {} : { fullVersionList }),
    ...(platformVersion === undefined ? {} : { platformVersion }),
    ...(model === undefined ? {} : { model }),
    ...(architecture === undefined ? {} : { architecture }),
    ...(bitness === undefined ? {} : { bitness })
  };
}
