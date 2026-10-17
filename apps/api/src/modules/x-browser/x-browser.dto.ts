import {
  allowXBrowserOrganizationSchema,
  enableXBrowserSchema,
  setKillSwitchSchema,
  xBrowserAdminSchema,
  xBrowserOrganizationSchema,
  xBrowserStatusSchema,
} from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';

// Request and response DTOs of the X browser (guide step 6.1). The schemas live in
// @smp/contracts, where the settings and the admin page use them too.

export class XBrowserStatusDto extends createZodDto(xBrowserStatusSchema) {}
export class EnableXBrowserDto extends createZodDto(enableXBrowserSchema) {}
export class XBrowserAdminDto extends createZodDto(xBrowserAdminSchema) {}
export class SetKillSwitchDto extends createZodDto(setKillSwitchSchema) {}
export class AllowXBrowserOrganizationDto extends createZodDto(allowXBrowserOrganizationSchema) {}
export class XBrowserOrganizationDto extends createZodDto(xBrowserOrganizationSchema) {}
