import { resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';
import { z } from 'zod';

// Prisma 7 does not read .env files itself. The single .env lives in the repository root.
// Variables that are already set (for example in CI) take precedence.
loadDotenv({ path: resolve(__dirname, '../../.env') });

// Optional, so that `prisma generate` runs in builds without a database. The migration commands
// need the URL and fail with Prisma's own message when it is missing.
const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ }).optional();
const migrationDatabaseUrl = postgresUrl.parse(process.env.MIGRATION_DATABASE_URL);
// Optional. `prisma migrate dev` needs a shadow database; `migrate deploy` does not.
const shadowDatabaseUrl = postgresUrl.parse(process.env.MIGRATION_SHADOW_DATABASE_URL);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/seed.ts',
  },
  datasource: {
    // Migrations run as app_migrator, the owner of the schema. Never as app_user.
    url: migrationDatabaseUrl,
    shadowDatabaseUrl,
  },
});
