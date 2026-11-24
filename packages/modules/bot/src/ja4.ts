/** A TLS stack a JA4 fingerprint's cipher hash identifies. */
export type TlsStack = 'chromium' | 'firefox' | 'safari' | 'python' | 'go';

/** A browser family a user agent claims. */
export type BrowserFamily = 'chromium' | 'firefox' | 'safari';

/**
 * Cipher hashes (JA4's second part: the sorted cipher suites, hashed) and the TLS stack each identifies, from FoxIO's
 * public JA4+ mapping (https://github.com/FoxIO-LLC/ja4/blob/main/ja4plus-mapping.csv). The cipher hash is what stays
 * put across a browser's releases (its extensions change; the third part follows them), and a hash that isn't here is
 * no decision, so a new browser version with a new cipher list is never flagged. Kept small on purpose: only stacks
 * that a browser user agent can't honestly come from, or the three browsers' own.
 */
const CIPHER_STACKS: ReadonlyMap<string, TlsStack> = new Map<string, TlsStack>([
  ['8daaf6152771', 'chromium'],
  ['5b57614c22b0', 'firefox'],
  ['a09f3c656075', 'safari'],
  ['85036bcba153', 'python'],
  ['c7886603b240', 'python'],
  ['9dc949149365', 'go'],
  ['e33ad33b3d25', 'go'],
  ['cbb2034c60b8', 'go'],
  ['8cdfa2d4673b', 'go']
]);

/**
 * The TLS stack a JA4 fingerprint identifies, by its cipher hash; undefined when it isn't in the table, or isn't a TCP
 * fingerprint. Over QUIC (`q…`) every browser offers the same three TLS 1.3 cipher suites, so their cipher hashes are
 * the same and say nothing about the browser.
 */
export function ja4Stack(ja4: string): TlsStack | undefined {
  if (!ja4.startsWith('t')) return undefined;
  const cipherHash = ja4.split('_')[1];
  return cipherHash === undefined ? undefined : CIPHER_STACKS.get(cipherHash);
}

/**
 * The browser family a user agent claims, or undefined when it claims none of the three or comes from an iPhone, iPad
 * or iPod, where every browser (Chrome's `CriOS`, Firefox's `FxiOS`, in-app browsers) uses Apple's TLS stack whatever
 * it calls itself. Only user agents that start `Mozilla/5.0 (` are read.
 */
export function claimedBrowser(userAgent: string): BrowserFamily | undefined {
  if (!userAgent.startsWith('Mozilla/5.0 (') || /\b(?:iPhone|iPad|iPod)\b/.test(userAgent)) return undefined;
  if (/\b(?:Chrome|Chromium)\/\d/.test(userAgent)) return 'chromium';
  if (/\bFirefox\/\d/.test(userAgent)) return 'firefox';
  if (/\bVersion\/\d+(?:\.\d+)*(?: Mobile\/\w+)? Safari\//.test(userAgent) && !/\bAndroid\b/.test(userAgent)) return 'safari';
  return undefined;
}

/**
 * Whether the client's JA4 fingerprint contradicts the browser its user agent claims: a Python or Go TLS stack behind
 * any browser user agent, or one browser's stack behind another's user agent. Conservative: no decision (false) for a
 * fingerprint or user agent that isn't recognized, over QUIC, and for Apple's stack behind a Mac user agent, which is
 * what iPad browsers send when they ask for desktop sites.
 */
export function ja4Contradicts(userAgent: string, ja4: string): boolean {
  const claimed = claimedBrowser(userAgent);
  const stack = ja4Stack(ja4);
  if (claimed === undefined || stack === undefined || stack === claimed) return false;
  if (stack === 'safari' && /\bMacintosh\b/.test(userAgent)) return false;
  return true;
}
