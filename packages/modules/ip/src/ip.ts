// The parser lives in core, where adapters check client IPs with it too; re-exported here for the module's users.
export { parseIp, type ParsedIp } from '@sharedid-edge/core';

export function formatIpv4(octets: readonly number[]): string {
  return octets.join('.');
}

/** RFC 5952 text: lowercase, no leading zeros, the longest run of two or more zero groups as `::`. */
export function formatIpv6(hextets: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < hextets.length; ) {
    if (hextets[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < hextets.length && hextets[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = hextets.map(h => h.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}
