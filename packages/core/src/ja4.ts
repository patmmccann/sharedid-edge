// The client's JA4 TLS fingerprint (FoxIO, https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md), as
// a platform computed it from the visitor's own TLS connection. Adapters check it here before putting it in
// PlatformInfo, so a module can rely on its shape. It's a fact about the connection, compared with the request by
// modules that opt in; never stored, logged, returned, or used to derive an identifier.

/**
 * `a_b_c`: `a` is the protocol (`t` TCP, `q` QUIC, `d` DTLS), the TLS version (`13`, `12`, `11`, `10`, `s3`, `s2`,
 * `d1` to `d3`, or `00`), SNI (`d` a domain, `i` none), the cipher and extension counts (two digits each) and the
 * ALPN's first and last characters (two alphanumerics, `00` for none); `b` and `c` are 12 lower-case hex digits each.
 */
const JA4 = /^[tqd](?:1[0-3]|s[23]|d[1-3]|00)[di]\d{4}[0-9A-Za-z]{2}_[0-9a-f]{12}_[0-9a-f]{12}$/;

/** The platform's JA4 value, trimmed, when it has the JA4 shape; undefined for anything else, including "not computed". */
export function ja4Value(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return JA4.test(trimmed) ? trimmed : undefined;
}
