import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { MemberRole, OrganizationActor } from '@smp/core';
import type { Request } from 'express';

/** What the WorkspaceGuard resolved for a tenant route. */
export interface RequestAccess {
  userId: string;
  organizationId: string;
  organizationName: string;
  role: MemberRole;
  workspaceId?: string;
  /** Since when the organization waits for its erasure (ISO 8601), or null (guide step 8.2). */
  deletedAt: string | null;
  /** Whether the members of the organization need a second factor (guide step 8.4). */
  requireTwoFactor: boolean;
}

export type RequestWithAccess = Request & { access?: RequestAccess };

export class MissingAccessError extends Error {
  constructor() {
    super('The route has no tenant scope; add @OrgScope() or @WorkspaceScope() to the controller.');
  }
}

export function requireAccess(request: RequestWithAccess): RequestAccess {
  if (!request.access) {
    throw new MissingAccessError();
  }
  return request.access;
}

/** The acting member of an organization or workspace route. */
export const Actor = createParamDecorator((_data: unknown, context: ExecutionContext): OrganizationActor => {
  const access = requireAccess(context.switchToHttp().getRequest<RequestWithAccess>());
  return { userId: access.userId, organizationId: access.organizationId, role: access.role };
});

/** The resolved access of the route, workspace included. */
export const Access = createParamDecorator((_data: unknown, context: ExecutionContext): RequestAccess =>
  requireAccess(context.switchToHttp().getRequest<RequestWithAccess>()),
);
