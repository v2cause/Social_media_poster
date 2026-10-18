import { isIP } from 'node:net';

import { normalizeIp } from '@nestjs/throttler';

/** What the address of a client is read from. */
export interface AddressedRequest {
  headers?: Record<string, unknown>;
  ip?: string;
}

/**
 * The address of the client: X-Real-IP from the reverse proxy (ADR 0006), IPv6 by its /64 network.
 * The throttlers count by it, and the security events name it.
 */
export function clientAddress(req: AddressedRequest): string {
  const header = req.headers?.['x-real-ip'];
  const address = typeof header === 'string' && isIP(header) ? header : (req.ip ?? 'unknown');
  return normalizeIp(address);
}
