import { z } from 'zod';

// Form schemas of the sign-in pages. The limits are the ones Better Auth enforces in the API
// (apps/api/src/modules/identity/auth.ts), so form and server agree.

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const emailSchema = z.email().max(254);
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type SignInRequest = z.infer<typeof signInSchema>;

export const signUpSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  password: passwordSchema,
});
export type SignUpRequest = z.infer<typeof signUpSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((value) => value.password === value.confirm, { path: ['confirm'], message: 'passwords_differ' });

/** The password change of a signed-in user (ASVS 6.2.3): the current password and a new one. */
export const changePasswordSchema = z
  .object({
    current: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    password: passwordSchema,
    confirm: z.string(),
    // Ends the sessions on every other device (ASVS 7.4.3).
    signOutOthers: z.boolean(),
  })
  .refine((value) => value.password === value.confirm, { path: ['confirm'], message: 'passwords_differ' });
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

/** Six digits from the authenticator app, or a backup code. */
export const twoFactorCodeSchema = z.object({ code: z.string().trim().min(6).max(32) });
