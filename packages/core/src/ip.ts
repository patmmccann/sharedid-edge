/** A parsed IP address. IPv4-mapped IPv6 addresses (`::ffff:192.0.2.1`) are IPv4. */
export type ParsedIp =
  | { readonly version: 4; readonly octets: readonly number[] }
  | { readonly version: 6; readonly hextets: readonly number[] };

const IPV4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HEXTET = /^[0-9a-fA-F]{1,4}$/;

/**
 * Parses a textual IPv4 or IPv6 address, or returns undefined if it isn't one. Zone IDs (`%eth0`) aren't accepted.
 * Adapters use it to check a client IP from platform data; modules (`ip`, `ec`) to read `PlatformInfo.clientIp`.
 */
export function parseIp(text: string): ParsedIp | undefined {
  const value = text.trim();
  if (value.length > 45) return undefined;
  const octets = parseIpv4(value);
  if (octets !== undefined) return { version: 4, octets };
  const hextets = parseIpv6(value);
  if (hextets === undefined) return undefined;
  if (hextets.slice(0, 5).every(h => h === 0) && hextets[5] === 0xffff) {
    const [high = 0, low = 0] = hextets.slice(6);
    return { version: 4, octets: [high >> 8, high & 0xff, low >> 8, low & 0xff] };
  }
  return { version: 6, hextets };
}

function parseIpv4(text: string): number[] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every(part => IPV4_OCTET.test(part))) return undefined;
  return parts.map(Number);
}

function parseIpv6(text: string): number[] | undefined {
  let value = text;
  // An embedded IPv4 address in the last 32 bits, as in ::ffff:192.0.2.1.
  const lastColon = value.lastIndexOf(':');
  if (lastColon >= 0 && value.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4(value.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    value = `${value.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const groups = (half: string | undefined): string[] => (half === undefined || half === '' ? [] : half.split(':'));
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  if (![...head, ...tail].every(group => HEXTET.test(group))) return undefined;
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return undefined;
  const zeros = new Array<string>(8 - head.length - tail.length).fill('0');
  return [...head, ...zeros, ...tail].map(group => parseInt(group, 16));
}
