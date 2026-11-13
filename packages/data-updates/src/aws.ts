import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { SnapshotStore } from './snapshot.js';

/** Use a private bucket and scope the role to its snapshot prefix. No static AWS credentials are required. */
export function s3Store(bucket: string, prefix = 'sharedid-data/', client: S3Client = new S3Client({})): SnapshotStore {
  if (bucket === '' || !prefix.endsWith('/')) throw new TypeError('Invalid snapshot bucket or prefix');
  return {
    async get(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + key }));
        return await result.Body?.transformToString();
      } catch (error) {
        if (error instanceof Error && error.name === 'NoSuchKey') return undefined;
        throw error;
      }
    },
    async put(key, value) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: prefix + key, Body: value, ContentType: 'application/json', CacheControl: 'no-store' }));
    }
  };
}
