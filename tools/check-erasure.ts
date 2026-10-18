// Checks that the erasure of an organization left nothing behind (guide step 8.2, ADR 0037): the
// request is finished and names nobody, no row names the organization or one of its workspaces,
// and the storage holds no object of its workspaces or exports. Exits with code 1 otherwise.
//
// Run from the repository root after `pnpm build`: pnpm check:erasure <id of the erasure request>

import { workspacePrefix, exportPrefixOf } from '@smp/core';
import { checkErasure, createSystemPrismaClient } from '@smp/db';
import { S3Storage, storageConfigOf } from '@smp/media';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_SYSTEM_URL: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.stringbool().default(true),
});

async function main(): Promise<void> {
  const requestId = z.uuid().safeParse(process.argv[2]);
  if (!requestId.success) {
    throw new Error('Usage: pnpm check:erasure <id of the erasure request>');
  }
  const env = envSchema.parse(process.env);
  const system = createSystemPrismaClient(env.DATABASE_SYSTEM_URL);
  const storage = new S3Storage(storageConfigOf({ ...env, S3_PUBLIC_ENDPOINT: undefined }));
  try {
    const check = await checkErasure(system, requestId.data);
    if (!check.request) {
      throw new Error(`There is no erasure request ${requestId.data}.`);
    }
    const problems: string[] = [];
    if (check.request.status !== 'COMPLETED') {
      problems.push(`The erasure is ${check.request.status}, not COMPLETED.`);
    }
    if (check.request.namesRequester) {
      problems.push('The record still names who asked for the erasure.');
    }
    for (const [table, count] of Object.entries(check.rows)) {
      problems.push(`${table}: ${String(count)} rows left`);
    }
    const prefixes = [
      exportPrefixOf(check.request.organizationId),
      ...check.request.workspaceIds.map(workspacePrefix),
    ];
    for (const prefix of prefixes) {
      const objects = await storage.countPrefix(prefix);
      if (objects > 0) {
        problems.push(`${prefix}: ${String(objects)} objects left`);
      }
    }
    if (problems.length === 0) {
      process.stdout.write(
        `Erasure ${check.request.id}: nothing left of the organization, ${String(prefixes.length)} prefixes checked.\n`,
      );
      return;
    }
    for (const problem of problems) {
      process.stderr.write(`${problem}\n`);
    }
    process.exitCode = 1;
  } finally {
    storage.destroy();
    await system.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
