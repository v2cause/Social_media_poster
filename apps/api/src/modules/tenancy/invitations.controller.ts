import { Body, Controller, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { hours } from '@nestjs/throttler';
import { AcceptInvitation, InvitationNotFoundError, systemClock } from '@smp/core';
import { secretTokens } from '@smp/crypto';
import type { TenancyReadModel } from '@smp/db';
import { ZodResponse } from 'nestjs-zod';

import { UserScope } from '../../common/decorators/access.decorators';
import { Public } from '../../common/decorators/public.decorator';
import { LimitPerUser } from '../../common/throttling/throttling';
import { TENANCY_READ_MODEL } from '../../infrastructure/clients.module';
import type { AuthSession } from '../identity/auth';
import { CurrentUser } from '../identity/current-user.decorator';
import { AcceptInvitationResponseDto, InvitationPreviewDto, InvitationTokenDto } from './tenancy.dto';

/**
 * Invitation links. The token travels in the body, never in the path, so that it does not end up
 * in request logs.
 */
@ApiTags('invitations')
@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly acceptInvitation: AcceptInvitation,
    @Inject(TENANCY_READ_MODEL) private readonly readModel: TenancyReadModel,
  ) {}

  /** What the invite page shows before sign-in or sign-up. */
  @LimitPerUser(30, hours(1))
  @Public()
  @Post('preview')
  @ZodResponse({ status: 200, type: InvitationPreviewDto })
  async preview(@Body() body: InvitationTokenDto): Promise<InvitationPreviewDto> {
    const invitation = await this.readModel.invitationPreview(secretTokens.hash(body.token));
    if (!invitation) {
      throw new InvitationNotFoundError();
    }
    const status =
      invitation.acceptedAt !== null || invitation.revokedAt !== null
        ? 'used'
        : invitation.expiresAt <= systemClock.now()
          ? 'expired'
          : 'open';
    return {
      organizationName: invitation.organizationName,
      invitedBy: invitation.invitedBy,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      status,
    };
  }

  @LimitPerUser(30, hours(1))
  @UserScope()
  @Post('accept')
  @ZodResponse({ status: 200, type: AcceptInvitationResponseDto })
  async accept(
    @CurrentUser() user: AuthSession['user'],
    @Body() body: InvitationTokenDto,
  ): Promise<AcceptInvitationResponseDto> {
    const { organizationId } = await this.acceptInvitation.execute({
      user: { id: user.id, email: user.email, emailVerified: user.emailVerified },
      token: body.token,
    });
    const memberships = await this.readModel.membershipsOfUser(user.id);
    const workspace = memberships.find((membership) => membership.organizationId === organizationId)
      ?.workspaces[0];
    return { organizationId, workspaceSlug: workspace?.slug ?? null };
  }
}
