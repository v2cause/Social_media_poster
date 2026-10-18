import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { hours } from '@nestjs/throttler';
import { toLocale } from '@smp/contracts';
import {
  ChangePlan,
  GetBillingOverview,
  ListInvoices,
  OpenBillingPortal,
  StartCheckout,
  type OrganizationActor,
} from '@smp/core';
import { ZodResponse } from 'nestjs-zod';

import { AllowWhenReadOnly, OrgScope, RequirePermission } from '../../common/decorators/access.decorators';
import { Access, Actor, type RequestAccess } from '../../common/guards/request-access';
import { LimitPerUser } from '../../common/throttling/throttling';
import type { AuthSession } from '../identity/auth';
import { CurrentUser } from '../identity/current-user.decorator';
import {
  BillingOverviewDto,
  BillingRedirectDto,
  ChangePlanRequestDto,
  CheckoutRequestDto,
  InvoiceListDto,
} from './billing.dto';
import { toBillingOverviewDto } from './billing.mappers';

/**
 * The billing of an organization for its owners (guide steps 7.2 and 7.5): the overview of plan,
 * usage and prices, the hosted checkout of a plan, the change of a running plan, the customer
 * portal of Stripe and the invoices. None of them changes the subscription here; the webhooks of
 * Stripe do.
 */
@ApiTags('billing')
@OrgScope()
// Paying is how a read-only organization becomes writable again.
@AllowWhenReadOnly()
@Controller('org/:org/billing')
export class BillingController {
  constructor(
    private readonly getOverview: GetBillingOverview,
    private readonly startCheckout: StartCheckout,
    private readonly changePlan: ChangePlan,
    private readonly openPortal: OpenBillingPortal,
    private readonly listInvoices: ListInvoices,
  ) {}

  @Get()
  @RequirePermission('billing.manage')
  @ZodResponse({ type: BillingOverviewDto })
  async overview(@Actor() actor: OrganizationActor): Promise<BillingOverviewDto> {
    return toBillingOverviewDto(await this.getOverview.execute(actor));
  }

  @LimitPerUser(30, hours(1))
  @Post('checkout')
  @RequirePermission('billing.manage')
  @HttpCode(201)
  @ZodResponse({ status: 201, type: BillingRedirectDto })
  async checkout(
    @Access() access: RequestAccess,
    @CurrentUser() user: AuthSession['user'],
    @Body() body: CheckoutRequestDto,
  ): Promise<BillingRedirectDto> {
    const url = await this.startCheckout.execute({
      actor: {
        userId: access.userId,
        organizationId: access.organizationId,
        role: access.role,
        email: user.email,
      },
      organizationName: access.organizationName,
      plan: body.plan,
      locale: toLocale(user.locale),
    });
    return { url };
  }

  @LimitPerUser(30, hours(1))
  @Post('plan')
  @RequirePermission('billing.manage')
  @HttpCode(204)
  async plan(@Actor() actor: OrganizationActor, @Body() body: ChangePlanRequestDto): Promise<void> {
    await this.changePlan.execute({ actor, plan: body.plan });
  }

  @LimitPerUser(30, hours(1))
  @Post('portal')
  @RequirePermission('billing.manage')
  @HttpCode(201)
  @ZodResponse({ status: 201, type: BillingRedirectDto })
  async portal(
    @Actor() actor: OrganizationActor,
    @CurrentUser() user: AuthSession['user'],
  ): Promise<BillingRedirectDto> {
    return { url: await this.openPortal.execute({ actor, locale: toLocale(user.locale) }) };
  }

  @Get('invoices')
  @RequirePermission('billing.manage')
  @ZodResponse({ type: InvoiceListDto })
  async invoices(@Actor() actor: OrganizationActor): Promise<InvoiceListDto> {
    const invoices = await this.listInvoices.execute(actor);
    return {
      items: invoices.map((invoice) => ({ ...invoice, createdAt: invoice.createdAt.toISOString() })),
    };
  }
}
