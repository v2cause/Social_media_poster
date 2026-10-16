'use client';

import { inferAdditionalFields, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

// Better Auth in the browser. Requests go to /api/auth on the same origin (architecture 10).
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [
    twoFactorClient(),
    inferAdditionalFields({
      user: {
        locale: { type: 'string', required: false },
        timezone: { type: 'string', required: false },
      },
    }),
  ],
});
