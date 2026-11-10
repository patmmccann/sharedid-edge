const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export interface TcStringOptions {
  /** Purpose legitimate interests in the core segment. */
  readonly legitimateInterests?: readonly number[];
  /** Purpose consents in a publisher TC segment; no publisher segment when omitted. */
  readonly publisher?: readonly number[];
  /** Purpose legitimate interests in the publisher TC segment (which is added if this is set). */
  readonly publisherLegitimateInterests?: readonly number[];
  /** Vendor consents in the core segment. */
  readonly vendors?: readonly number[];
  /** How the vendor consents are encoded; a bit field by default. */
  readonly vendorEncoding?: 'bitfield' | 'range';
  readonly version?: number;
}

/**
 * A TCF v2 TC string: a core segment with the given (vendor) purpose consents and, optionally, a publisher TC segment.
 * Other fields are zero, which the decoder doesn't read. Segments are padded to a multiple of 6 bits, as real ones are.
 */
export function tcString(purposes: readonly number[], options: TcStringOptions = {}): string {
  const bits: number[] = [];
  pushInt(bits, options.version ?? 2, 6);
  while (bits.length < 152) bits.push(0);
  pushPurposes(bits, purposes);
  pushPurposes(bits, options.legitimateInterests ?? []);
  while (bits.length < 213) bits.push(0);
  pushVendors(bits, options.vendors ?? [], options.vendorEncoding ?? 'bitfield');
  if (options.publisher === undefined && options.publisherLegitimateInterests === undefined) return encode(bits);
  const publisher: number[] = [];
  pushInt(publisher, 3, 3); // SegmentType: publisher TC
  pushPurposes(publisher, options.publisher ?? []); // PubPurposesConsent
  pushPurposes(publisher, options.publisherLegitimateInterests ?? []); // PubPurposesLITransparency
  pushInt(publisher, 0, 6); // NumCustomPurposes
  return `${encode(bits)}.${encode(publisher)}`;
}

/** A TC string whose publisher TC segment consents to the given purposes, and whose core segment consents to none. */
export function publisherTc(purposes: readonly number[]): string {
  return tcString([], { publisher: purposes });
}

function pushVendors(bits: number[], vendors: readonly number[], encoding: 'bitfield' | 'range'): void {
  const maxVendorId = Math.max(0, ...vendors);
  pushInt(bits, maxVendorId, 16);
  bits.push(encoding === 'range' ? 1 : 0);
  if (encoding === 'bitfield') {
    for (let v = 1; v <= maxVendorId; v++) bits.push(vendors.includes(v) ? 1 : 0);
    return;
  }
  // one entry per run of consecutive vendors: a single ID or a range
  const sorted = [...vendors].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const v of sorted) {
    const last = runs.at(-1);
    if (last !== undefined && v === last[1] + 1) last[1] = v;
    else runs.push([v, v]);
  }
  pushInt(bits, runs.length, 12);
  for (const [first, last] of runs) {
    bits.push(first === last ? 0 : 1);
    pushInt(bits, first, 16);
    if (first !== last) pushInt(bits, last, 16);
  }
}

function pushInt(bits: number[], value: number, length: number): void {
  for (let bit = length - 1; bit >= 0; bit--) bits.push((value >> bit) & 1);
}

function pushPurposes(bits: number[], purposes: readonly number[]): void {
  for (let p = 1; p <= 24; p++) bits.push(purposes.includes(p) ? 1 : 0);
}

function encode(input: readonly number[]): string {
  const bits = [...input];
  while (bits.length % 6 !== 0) bits.push(0);
  let out = '';
  for (let i = 0; i < bits.length; i += 6) {
    let value = 0;
    for (let j = 0; j < 6; j++) value = value * 2 + (bits[i + j] ?? 0);
    out += BASE64URL[value] ?? '';
  }
  return out;
}

export interface ParsedSetCookie {
  readonly name: string;
  readonly value: string;
  readonly attributes: ReadonlyMap<string, string>;
}

/** Parses `Set-Cookie` headers into name, value and lowercased attribute names. */
export function setCookies(response: Response): ParsedSetCookie[] {
  return response.headers.getSetCookie().map(header => {
    const [pair = '', ...attrs] = header.split(';').map(s => s.trim());
    const eq = pair.indexOf('=');
    const attributes = new Map<string, string>();
    for (const attr of attrs) {
      const i = attr.indexOf('=');
      attributes.set((i < 0 ? attr : attr.slice(0, i)).toLowerCase(), i < 0 ? '' : attr.slice(i + 1));
    }
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
  });
}

export function cookieNamed(response: Response, name: string): ParsedSetCookie | undefined {
  return setCookies(response).find(c => c.name === name);
}
