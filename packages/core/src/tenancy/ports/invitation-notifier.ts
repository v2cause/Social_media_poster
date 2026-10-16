import type { MemberRole } from '../domain/types';

export interface InvitationMessage {
  invitationId: string;
  organizationId: string;
  email: string;
  /** The token for the link. It exists only here and in the email. */
  token: string;
  role: MemberRole;
  inviterUserId: string;
  expiresAt: Date;
}

/** Delivers invitations, after the transaction that created them has committed. */
export interface InvitationNotifier {
  invitationCreated(message: InvitationMessage): Promise<void>;
}
