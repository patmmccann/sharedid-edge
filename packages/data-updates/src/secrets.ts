/** Read the same per-module secret map as the request handler, without reading any visitor configuration. */
export function updateSecrets(raw: string | undefined): Readonly<Record<string, Readonly<Record<string, string>>>> {
  let value: unknown;
  try { value = JSON.parse(raw === undefined || raw === '' ? '{}' : raw); }
  catch { throw new TypeError('Invalid SID_MODULE_SECRETS'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid SID_MODULE_SECRETS');
  const result: Record<string, Record<string, string>> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new TypeError('Invalid SID_MODULE_SECRETS entry');
    const secrets: Record<string, string> = {};
    for (const [key, secret] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof secret !== 'string') throw new TypeError('Invalid SID_MODULE_SECRETS value');
      Object.defineProperty(secrets, key, { value: secret, enumerable: true });
    }
    Object.defineProperty(result, name, { value: secrets, enumerable: true });
  }
  return result;
}
