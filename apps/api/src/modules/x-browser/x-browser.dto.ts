import {
  allowXBrowserOrganizationSchema,
  enableXBrowserSchema,
  setKillSwitchSchema,
  startXbLoginSchema,
  xBrowserAdminSchema,
  xBrowserOrganizationSchema,
  xBrowserStatusSchema,
  xbLoginCodeSchema,
  xbLoginSessionSchema,
} from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';

// Request and response DTOs of the X browser (guide steps 6.1 and 6.4). The schemas live in
// @smp/contracts, where the settings, the login dialog and the admin page use them too.

export class XBrowserStatusDto extends createZodDto(xBrowserStatusSchema) {}
export class EnableXBrowserDto extends createZodDto(enableXBrowserSchema) {}
export class XBrowserAdminDto extends createZodDto(xBrowserAdminSchema) {}
export class SetKillSwitchDto extends createZodDto(setKillSwitchSchema) {}
export class AllowXBrowserOrganizationDto extends createZodDto(allowXBrowserOrganizationSchema) {}
export class XBrowserOrganizationDto extends createZodDto(xBrowserOrganizationSchema) {}
export class StartXbLoginDto extends createZodDto(startXbLoginSchema) {}
export class XbLoginCodeDto extends createZodDto(xbLoginCodeSchema) {}
export class XbLoginSessionDto extends createZodDto(xbLoginSessionSchema) {}
