// Spike for guide step 0.14(e): presigned PUT against the local object store, including CORS.
//
// The browser uploads straight to S3 with a presigned URL. The API then checks the object
// (HeadObject) before the asset counts as uploaded. This script checks each step with the same
// signature rules the browser depends on. Run from the repository root with the local stack up:
//   pnpm exec tsx tools/spikes/s3-presign.ts

import { randomUUID } from 'node:crypto';

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ORIGIN = 'http://localhost:3000';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Load the root .env first.`);
  }
  return value;
};

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const bucket = env('S3_BUCKET');
  const endpoint = env('S3_ENDPOINT');
  const client = new S3Client({
    endpoint,
    region: env('S3_REGION'),
    forcePathStyle: true,
    // Newer SDKs add a CRC32 checksum to presigned requests, computed for an empty body. A browser
    // upload then fails the signature check. The checksum is only sent when S3 requires it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env('S3_ACCESS_KEY_ID'), secretAccessKey: env('S3_SECRET_ACCESS_KEY') },
  });

  const key = `spike/${randomUUID()}.jpg`;
  const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 1024 }, (_, i) => i % 256)]);
  const checks: Check[] = [];

  const putUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'image/jpeg', ContentLength: body.length }),
    { expiresIn: 300, signableHeaders: new Set(['content-type']) },
  );

  // 1. The presigned PUT works with the signed content type.
  const put = await fetch(putUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body });
  checks.push({ name: 'presigned PUT accepted', passed: put.ok, detail: `HTTP ${String(put.status)}` });

  // 2. HeadObject reports the size and the type the API will compare against.
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  checks.push({
    name: 'HeadObject returns size and content type',
    passed: head.ContentLength === body.length && head.ContentType === 'image/jpeg',
    detail: `size=${String(head.ContentLength)} type=${String(head.ContentType)}`,
  });

  // 3. A different content type than the signed one is rejected.
  const mismatch = await fetch(putUrl, { method: 'PUT', headers: { 'content-type': 'text/html' }, body });
  checks.push({
    name: 'content type change is rejected',
    passed: !mismatch.ok,
    detail: `HTTP ${String(mismatch.status)}`,
  });

  // 4. CORS preflight for the browser upload from the web origin.
  const preflight = await fetch(putUrl, {
    method: 'OPTIONS',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'content-type',
    },
  });
  const allowOrigin = preflight.headers.get('access-control-allow-origin');
  const allowMethods = preflight.headers.get('access-control-allow-methods') ?? '';
  checks.push({
    name: 'CORS preflight allows PUT from the web origin',
    passed: allowOrigin === ORIGIN && allowMethods.includes('PUT'),
    detail: `HTTP ${String(preflight.status)}, allow-origin=${allowOrigin ?? 'none'}, allow-methods=${allowMethods || 'none'}`,
  });

  // 5. An expired presigned URL is rejected.
  const expiredUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: `spike/${randomUUID()}.jpg`, ContentType: 'image/jpeg' }),
    { expiresIn: 1 },
  );
  await new Promise((resolve) => {
    setTimeout(resolve, 2_500);
  });
  const expired = await fetch(expiredUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body });
  checks.push({
    name: 'expired presigned URL is rejected',
    passed: !expired.ok,
    detail: `HTTP ${String(expired.status)}`,
  });

  // Cleanup: the spike object is removed again. The check above proves the object existed.
  await client.send(
    new (await import('@aws-sdk/client-s3')).DeleteObjectCommand({ Bucket: bucket, Key: key }),
  );

  const passed = checks.every((check) => check.passed);
  process.stdout.write(`${JSON.stringify({ endpoint, passed, checks }, null, 2)}\n`);
  if (!passed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
