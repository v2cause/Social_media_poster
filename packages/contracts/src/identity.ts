import { z } from 'zod';

import { localeSchema } from './locale';

/** The signed-in user as GET /api/me returns it. */
export const meSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  locale: localeSchema,
  timezone: z.string(),
});

export type Me = z.infer<typeof meSchema>;
