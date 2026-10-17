import {
  billingRedirectSchema,
  changePlanRequestSchema,
  checkoutRequestSchema,
  invoiceListSchema,
} from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';

// Request and response DTOs of billing (guide steps 7.2 and 7.5). The schemas live in
// @smp/contracts, where the billing page uses them too.

export class CheckoutRequestDto extends createZodDto(checkoutRequestSchema) {}
export class ChangePlanRequestDto extends createZodDto(changePlanRequestSchema) {}
export class BillingRedirectDto extends createZodDto(billingRedirectSchema) {}
export class InvoiceListDto extends createZodDto(invoiceListSchema) {}
