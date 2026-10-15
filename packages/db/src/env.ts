import { z } from 'zod';

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

// One URL per database role. The roles are created in infra/docker/postgres/init.
export const dbEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
  DATABASE_SYSTEM_URL: postgresUrl,
  MIGRATION_DATABASE_URL: postgresUrl,
});

export type DbEnv = z.infer<typeof dbEnvSchema>;
