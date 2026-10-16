import { z } from 'zod';

// GET /api/org/:org/audit-log (guide step 1.7): newest first, cursor pagination, filters for
// action, actor and period.

export const auditLogQuerySchema = z
  .object({
    action: z.string().trim().min(1).max(100).optional(),
    actorUserId: z.uuid().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, { message: 'from_after_to' });
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

const metadataValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);

export const auditLogEntrySchema = z.object({
  id: z.uuid(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  workspaceId: z.uuid().nullable(),
  actor: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  metadata: z.record(z.string(), metadataValue).nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditLogPageSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
});
export type AuditLogPage = z.infer<typeof auditLogPageSchema>;
