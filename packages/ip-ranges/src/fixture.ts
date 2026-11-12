import type { RangeTableSource } from './build.js';

const v4 = (a: number, b: number, c: number, d: number): number => a * 0x1000000 + ((b << 16) | (c << 8) | d);

/**
 * The fixture table IP database modules ship with until their build script replaces it with real data. It covers only
 * the documentation addresses (RFC 5737's 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24, and RFC 3849's
 * 2001:db8::/32), which never reach a worker from a real visitor, so a deployment without real data finds nothing.
 * Tests and the conformance suite use it. Hand-made, so free to publish.
 *
 * - 192.0.2.0/25: FR; 192.0.2.128/25: XK (no ISO alpha-3 code); 198.51.100.0/24: JP; 203.0.113.0/24: BR.
 * - 2001:db8::/48: FR; 2001:db8:1::/48: JP.
 */
export const FIXTURE_TABLE: RangeTableSource = Object.freeze({
  values: Object.freeze(['FR', 'XK', 'JP', 'BR']),
  v4: Object.freeze([
    [0, 0],
    [v4(192, 0, 2, 0), 1],
    [v4(192, 0, 2, 128), 2],
    [v4(192, 0, 3, 0), 0],
    [v4(198, 51, 100, 0), 3],
    [v4(198, 51, 101, 0), 0],
    [v4(203, 0, 113, 0), 4],
    [v4(203, 0, 114, 0), 0]
  ] as const),
  v6: Object.freeze([
    [0n, 0],
    [0x20010db8_00000000n, 1],
    [0x20010db8_00010000n, 3],
    [0x20010db8_00020000n, 0]
  ] as const)
});
