import type { Provider } from '@nestjs/common';
import {
  AcceptInvitation,
  ChangeMemberRole,
  CreateOrganization,
  CreateWorkspace,
  EntitlementsService,
  InviteMember,
  LeaveOrganization,
  RemoveMember,
  ResendInvitation,
  RevokeInvitation,
  SetTwoFactorRequirement,
  systemClock,
  UpdateWorkspaceSettings,
  uuidV7Ids,
  type InvitationNotifier,
  type TenancyDependencies,
  type TenancyUnitOfWork,
} from '@smp/core';
import { secretTokens } from '@smp/crypto';

import { TENANCY_UNIT_OF_WORK } from '../../infrastructure/clients.module';
import { INVITATION_NOTIFIER, QueueInvitationNotifier } from './invitation-notifier';

export const TENANCY_DEPENDENCIES = Symbol('TENANCY_DEPENDENCIES');

const USE_CASES = [
  AcceptInvitation,
  ChangeMemberRole,
  CreateOrganization,
  CreateWorkspace,
  InviteMember,
  LeaveOrganization,
  RemoveMember,
  ResendInvitation,
  RevokeInvitation,
  SetTwoFactorRequirement,
  UpdateWorkspaceSettings,
] as const;

/** The use cases of the core, wired to the adapters of the API. */
export const tenancyProviders: Provider[] = [
  { provide: INVITATION_NOTIFIER, useClass: QueueInvitationNotifier },
  {
    provide: TENANCY_DEPENDENCIES,
    inject: [TENANCY_UNIT_OF_WORK, INVITATION_NOTIFIER, EntitlementsService],
    useFactory: (
      unitOfWork: TenancyUnitOfWork,
      notifier: InvitationNotifier,
      entitlements: EntitlementsService,
    ): TenancyDependencies => ({
      unitOfWork,
      notifier,
      clock: systemClock,
      ids: uuidV7Ids,
      tokens: secretTokens,
      entitlements,
    }),
  },
  ...USE_CASES.map((UseCase) => ({
    provide: UseCase,
    inject: [TENANCY_DEPENDENCIES],
    useFactory: (deps: TenancyDependencies) => new UseCase(deps),
  })),
];
