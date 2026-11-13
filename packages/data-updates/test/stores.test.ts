import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { kvStore, r2Store, scheduledUpdate } from '../src/cloudflare.js';
import { s3Store } from '../src/aws.js';
import { fileStore } from '../src/node.js';
import { listSource, MemoryStore } from './helpers.js';
import { refreshData } from '../src/index.js';

describe('platform storage', () => {
  it('publishes the first S3 snapshot after NoSuchKey but does not download or write after AccessDenied', async () => {
    const values = new Map<string, string>();
    let canDistinguishMissing = false;
    const send = vi.spyOn(S3Client.prototype, 'send');
    const client = new S3Client({ region: 'us-east-1' });
    const source = listSource();
    try {
      send.mockImplementation(command => {
        if (command instanceof GetObjectCommand) {
          const key = command.input.Key;
          const value = key === undefined ? undefined : values.get(key);
          if (value === undefined) {
            throw Object.assign(new Error('Missing object'), { name: canDistinguishMissing ? 'NoSuchKey' : 'AccessDenied' });
          }
          return { Body: { transformToString: () => Promise.resolve(value) } };
        }
        if (command instanceof DeleteObjectCommand) {
        if (command.input.Key !== undefined) values.delete(command.input.Key);
        return {};
      }
      if (!(command instanceof PutObjectCommand) || command.input.Key === undefined || typeof command.input.Body !== 'string') {
          throw new TypeError('Unexpected S3 test command');
        }
        values.set(command.input.Key, command.input.Body);
        return {};
      });
      const store = s3Store('private-bucket', 'data/', client);
      expect(await refreshData(source, { store })).toEqual({ name: 'list', status: 'failed' });
      expect(source.download).not.toHaveBeenCalled();
      expect(values.size).toBe(0);
      canDistinguishMissing = true;
      expect(await refreshData(source, { store })).toEqual({ name: 'list', status: 'updated' });
      expect(source.download).toHaveBeenCalledOnce();
      expect(values.size).toBe(2);
      expect(JSON.parse(values.get('data/list/current.json') ?? '{}')).toMatchObject({ source: 'list', version: 1 });
    } finally { send.mockRestore(); client.destroy(); }
  });
  it('reads/writes private KV and R2 bindings and fails the scheduled invocation when any source fails', async () => {
    const kv = new Map<string, string>();
    const get = vi.fn((key: string) => Promise.resolve(kv.get(key) ?? null));
    const put = vi.fn((key: string, value: string) => { kv.set(key, value); return Promise.resolve(); });
    const remove = vi.fn((key: string) => { kv.delete(key); return Promise.resolve(); });
    const store = kvStore({ get, put, delete: remove });
    expect(await store.get('missing')).toBeUndefined();
    await store.put('key', 'value');
    expect(await store.get('key')).toBe('value');
    const r2 = r2Store({ get: key => Promise.resolve(kv.has(key) ? { text: () => Promise.resolve(kv.get(key) ?? '') } : null), put, delete: remove });
    expect(await r2.get('missing')).toBeUndefined();
    expect(await r2.get('key')).toBe('value');
    await r2.put('key', 'changed');
    expect(await store.get('key')).toBe('changed');
    await r2.delete('key');
    expect(await store.get('key')).toBeUndefined();
    await store.put('key', 'again');
    await store.delete('key');
    expect(remove.mock.calls).toEqual([['key'], ['key']]);
    expect(await r2.get('key')).toBeUndefined();
    await expect(scheduledUpdate([listSource()], { store: new MemoryStore() })).resolves.toBeUndefined();
    await expect(scheduledUpdate([{ ...listSource(), download: () => Promise.reject(new Error('secret')) }], { store: new MemoryStore() })).rejects.toThrow('Scheduled reference-data update failed');
  });

  it('uses S3 commands with a deployment prefix and distinguishes missing data from permission failures', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const client = new S3Client({ region: 'us-east-1' });
    try {
      const store = s3Store('private-bucket', 'data/', client);
      send.mockImplementationOnce(() => ({ Body: { transformToString: () => Promise.resolve('snapshot') } }));
      expect(await store.get('key')).toBe('snapshot');
      expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
      expect(send.mock.calls[0]?.[0].input).toMatchObject({ Bucket: 'private-bucket', Key: 'data/key' });
      send.mockImplementationOnce(() => ({}));
      await store.put('key', 'next');
      expect(send.mock.calls[1]?.[0]).toBeInstanceOf(PutObjectCommand);
      expect(send.mock.calls[1]?.[0].input).toMatchObject({ Body: 'next', CacheControl: 'no-store' });
      send.mockImplementationOnce(() => ({}));
      await store.delete('old');
      expect(send.mock.calls[2]?.[0]).toBeInstanceOf(DeleteObjectCommand);
      expect(send.mock.calls[2]?.[0].input).toMatchObject({ Bucket: 'private-bucket', Key: 'data/old' });
      send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
      expect(await store.get('missing')).toBeUndefined();
      send.mockRejectedValueOnce(new Error('AccessDenied'));
      await expect(store.get('key')).rejects.toThrow('AccessDenied');
    } finally { send.mockRestore(); client.destroy(); }
  });

  it('atomically replaces restrictive local files and refuses path traversal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sharedid-data-test-'));
    try {
      const store = fileStore(directory);
      expect(await store.get('dbip/current.json')).toBeUndefined();
      await store.put('dbip/current.json', 'first');
      await store.put('dbip/current.json', 'second');
      expect(await store.get('dbip/current.json')).toBe('second');
      await expect(store.put('../../escape', 'bad')).rejects.toThrow('Invalid snapshot key');
      await expect(store.delete('../../escape')).rejects.toThrow('Invalid snapshot key');
      const body = `dbip/${'a'.repeat(64)}.json`;
      await store.put(body, 'old');
      await store.delete(body);
      expect(await store.get(body)).toBeUndefined();
      await expect(store.delete(body)).resolves.toBeUndefined(); // Deleting a missing body succeeds.
      expect((await stat(join(directory, 'dbip/current.json'))).mode & 0o777).toBe(0o600);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('runs the installed Node command with local fake data, exposes no secrets, and exits nonzero on failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sharedid-update-cli-'));
    try {
      const config = join(directory, 'sources.mjs');
      await writeFile(config, 'export default [{name:"list",download:async()=>({bytes:new Uint8Array([49])}),decode:()=>({value:1}),validate:value=>value}];');
      const cli = join(import.meta.dirname, '../dist/cli.js');
      const run = promisify(execFile);
      const args = [cli, config, '--dir', join(directory, 'data')];
      const first = await run(process.execPath, args);
      expect(first.stdout).toContain('list: updated');
      const second = await run(process.execPath, args);
      expect(second.stdout).toContain('list: unchanged');
      expect(await readFile(join(directory, 'data/list/current.json'), 'utf8')).toContain('checkedAt');
      await writeFile(config, 'export default [{name:"list",download:async()=>{throw Error("private-key")},decode:()=>0,validate:value=>value}];');
      await expect(run(process.execPath, args)).rejects.toMatchObject({ code: 1, stdout: 'list: failed\n' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
