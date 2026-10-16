import { z } from 'zod';

import type { S3StorageConfig } from './s3-storage';

// The object storage settings of the API and the worker (.env.example, ADR 0008). Inside Docker
// the services reach the storage under S3_ENDPOINT; presigned URLs must work in the browser, so
// they are signed for S3_PUBLIC_ENDPOINT when it is set.

// .env.example and Compose set empty strings for unset values.
const unsetIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

export const storageEnvSchema = z.object({
  S3_ENDPOINT: z.url(),
  S3_PUBLIC_ENDPOINT: z.preprocess(unsetIfEmpty, z.url().optional()),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.stringbool().default(true),
});

export type StorageEnv = z.infer<typeof storageEnvSchema>;

export const storageConfigOf = (env: StorageEnv): S3StorageConfig => ({
  endpoint: env.S3_ENDPOINT,
  ...(env.S3_PUBLIC_ENDPOINT === undefined ? {} : { publicEndpoint: env.S3_PUBLIC_ENDPOINT }),
  region: env.S3_REGION,
  bucket: env.S3_BUCKET,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});
