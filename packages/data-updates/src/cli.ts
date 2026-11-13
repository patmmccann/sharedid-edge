#!/usr/bin/env node
import { mkdir, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fileStore } from './node.js';
import { updateSecrets } from './secrets.js';
import { runUpdates, type UpdateSource } from './update.js';

function sources(value: unknown): readonly UpdateSource[] {
  if (!Array.isArray(value)) throw new TypeError('Expected update sources');
  return value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('name' in entry) || typeof entry.name !== 'string' ||
        !('download' in entry) || typeof entry.download !== 'function' || !('decode' in entry) || typeof entry.decode !== 'function' ||
        !('validate' in entry) || typeof entry.validate !== 'function') throw new TypeError('Invalid update source');
    // The configured module is trusted deployment code; its required callbacks and name have been checked.
    return entry as UpdateSource;
  });
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help === true) {
    console.log('Usage: sharedid-edge-update <sources.mjs> --dir <private-data-directory>');
  } else {
    const config = positionals[0];
    if (positionals.length !== 1 || config === undefined || values.dir === undefined) throw new TypeError('Expected sources file and --dir');
    const directory = resolve(values.dir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = resolve(directory, '.update-lock');
    await mkdir(lock); // Excludes overlapping local cron runs. After a crash, an operator removes the empty lock.
    try {
      const imported: unknown = await import(pathToFileURL(resolve(config)).href);
      if (typeof imported !== 'object' || imported === null || !('default' in imported)) throw new TypeError('Expected default sources export');
      const reports = await runUpdates(sources(imported.default), { store: fileStore(directory), secrets: updateSecrets(process.env['SID_MODULE_SECRETS']) });
      for (const report of reports) console.log(`${report.name}: ${report.status}`);
      if (reports.some(report => report.status === 'failed')) process.exitCode = 1;
    } finally { await rmdir(lock); }
  }
} catch {
  console.error('sharedid-edge-update failed: check the sources file, secret settings, storage permissions and update lock.');
  process.exitCode = 1;
}
