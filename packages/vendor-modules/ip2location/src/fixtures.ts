import type { RangeTableSource } from '@sharedid-edge/ip-ranges/build';

const v4 = (a: number, b: number, c: number, d: number): number => a * 0x1000000 + ((b << 16) | (c << 8) | d);

/**
 * The hand-made proxy fixture, so a deployment without real data finds nothing. Tests, the conformance suite and the
 * build script's `--fixture` use it. Values are comma-separated proxy kinds, most specific first.
 *
 * - 192.0.2.0/26 tor; 192.0.2.64/26 vpn; 192.0.2.128/26 residential; 192.0.2.192/26 public.
 * - 198.51.100.0/25 public and datacenter (public is the more specific).
 * - 2001:db8::/48 tor; 2001:db8:1::/48 vpn.
 */
export const PROXY_FIXTURE_TABLE: RangeTableSource = Object.freeze({
  values: Object.freeze(['tor', 'vpn', 'residential', 'public', 'public,datacenter']),
  v4: Object.freeze([
    [0, 0],
    [v4(192, 0, 2, 0), 1],
    [v4(192, 0, 2, 64), 2],
    [v4(192, 0, 2, 128), 3],
    [v4(192, 0, 2, 192), 4],
    [v4(192, 0, 3, 0), 0],
    [v4(198, 51, 100, 0), 5],
    [v4(198, 51, 100, 128), 0]
  ] as const),
  v6: Object.freeze([
    [0n, 0],
    [0x20010db8_00000000n, 1],
    [0x20010db8_00010000n, 2],
    [0x20010db8_00020000n, 0]
  ] as const)
});
