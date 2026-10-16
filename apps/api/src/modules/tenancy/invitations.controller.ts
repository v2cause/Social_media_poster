import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { AcceptInvitation, InvitationNotFoundError, systemClock } from '@smp/core';
import { secretTokens } from '@smp/crypto';
import type { TenancyReadModel } from '@smp/db';
import { ZodSerializerDto } from 'nestjs-zod';

import { UserScope } from '../../common/decorators/access.decorators';
import { Public } from '../../common/decorators/public.decorator';
import { TENANCY_READ_MODEL } from '../../infrastructure/clients.module';
import type { AuthSession } from '../identity/auth';
import { CurrentUser } from '../identity/current-user.decorator';
import { AcceptInvitationResponseDto, InvitationPreviewDto, InvitationTokenDto } from './tenancy.dto';

/**
 * Invitation links. The token travels in the body, never in the path, so that it does not end up
 * in request logs.
 */
@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly acceptInvitation: AcceptInvitation,
    @Inject(TENANCY_READ_MODEL) private readonly readModel: TenancyReadModel,
  ) {}

  /** What the invite page shows before sign-in or sign-up. */
  @Public()
  @Post('preview')
  @HttpCode(200)
  @ZodSerializerDto(InvitationPreviewDto)
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

  @UserScope()
  @Post('accept')
  @HttpCode(200)
  @ZodSerializerDto(AcceptInvitationResponseDto)
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
