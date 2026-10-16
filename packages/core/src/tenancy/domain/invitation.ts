import { InvitationEmailMismatchError, InvitationExpiredError, InvitationUsedError } from './errors';
import type { Invitation } from './types';

/** Invitations are valid for seven days and can be used once (guide step 1.5). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Throws unless the invitation is open and not expired at the given time. */
export function assertInvitationOpen(invitation: Invitation, now: Date): void {
  if (invitation.acceptedAt !== null || invitation.revokedAt !== null) {
    throw new InvitationUsedError();
  }
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    throw new InvitationExpiredError();
  }
}

/** The invitation must be accepted with the address it was sent to. */
export function assertInvitationRecipient(invitation: Invitation, email: string): void {
  if (normalizeEmail(invitation.email) !== normalizeEmail(email)) {
    throw new InvitationEmailMismatchError();
  }
}
