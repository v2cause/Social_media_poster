import { assertTenantFilter } from './assert-tenant-filter.extension';
import { Prisma, type PrismaClient } from './generated/prisma/client';
import { MissingTenantContextError, setTenantContext, type TenantContextProvider } from './tenant-context';

export interface TenantClientOptions {
  /** Checks the explicit tenant filter of every query. On in development and tests. */
  assertTenantFilter?: boolean;
}

/**
 * Wraps every model operation in a batch transaction that first sets the tenant context
 * (guide step 1.3). Throws when there is no context instead of running without one.
 */
export const tenantExtension = (
  base: PrismaClient,
  getContext: TenantContextProvider,
  options: TenantClientOptions = {},
) =>
  Prisma.defineExtension({
    name: 'tenant-context',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const context = getContext();
          if (!context) {
            throw new MissingTenantContextError(`${model}.${operation}`);
          }
          if (options.assertTenantFilter) {
            assertTenantFilter(model, operation, args, context);
          }
          const [, result] = await base.$transaction([setTenantContext(base, context), query(args)]);
          return result;
        },
      },
    },
  });

/** The client for requests and jobs: app_user, every model operation in the current context. */
export const createTenantClient = (
  base: PrismaClient,
  getContext: TenantContextProvider,
  options: TenantClientOptions = {},
) => base.$extends(tenantExtension(base, getContext, options));

export type TenantPrismaClient = ReturnType<typeof createTenantClient>;
