import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client';

// Pass the URL of the role the caller needs: DATABASE_URL (app_user) for requests,
// DATABASE_SYSTEM_URL (app_system) only for @SystemScope() repository methods.
export const createPrismaClient = (connectionString: string): PrismaClient =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
