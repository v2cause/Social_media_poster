import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'smp:is-public';

/** The route needs no session. Every other route is denied without one (guide step 1.6). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
