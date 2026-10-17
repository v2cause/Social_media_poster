import type { VariantStatus } from '@smp/core';
import { z } from 'zod';

import { InvalidCursorError } from '../audit/audit-log-read-model';
import type { Platform, Prisma, PrismaClient, SocialAccountType } from '../generated/prisma/client';
import { withTenantTx, type WorkspaceRef } from '../tenant-context';

// The variants of a workspace with their plan (guide step 4.11): the calendar asks for a period
// in the order of the plan, the dashboard for the next ones, the post list for the last changed
// with filters. The cursor is the position of the last variant of a page in its order.

export type VariantListOrder = 'recent' | 'schedule';

export interface VariantListFilter {
  /** Without statuses every variant but DELETED. */
  statuses?: VariantStatus[];
  platform?: Platform;
  accountId?: string;
  /** The planned time, from (inclusive) to (exclusive). */
  from?: Date;
  to?: Date;
  order: VariantListOrder;
  cursor?: string;
  limit: number;
}

export interface VariantListItemView {
  id: string;
  postId: string;
  platform: Platform;
  status: VariantStatus;
  version: number;
  preview: string;
  account: { id: string; name: string; handle: string | null; type: SocialAccountType } | null;
  scheduledAt: Date | null;
  scheduledTimezone: string | null;
  publishedAt: Date | null;
  externalUrl: string | null;
  failureCode: string | null;
  isDryRun: boolean;
  updatedAt: Date;
}

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });
type Cursor = z.infer<typeof cursorSchema>;

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(value: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new InvalidCursorError();
  }
}

const PREVIEW_LENGTH = 140;

const previewOf = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 3).trimEnd()}...` : line;
};

/** The variants after the cursor, in the order of the list. */
function afterCursor(order: VariantListOrder, cursor: Cursor): Prisma.PostVariantWhereInput {
  const at = new Date(cursor.at);
  return order === 'schedule'
    ? { OR: [{ scheduledAt: { gt: at } }, { scheduledAt: at, id: { gt: cursor.id } }] }
    : { OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: cursor.id } }] };
}

export class VariantListReadModel {
  constructor(private readonly base: PrismaClient) {}

  list(
    ref: WorkspaceRef,
    filter: VariantListFilter,
  ): Promise<{ items: VariantListItemView[]; nextCursor: string | null }> {
    const after = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    return withTenantTx(this.base, ref, async (tx) => {
      const rows = await tx.postVariant.findMany({
        where: {
          workspaceId: ref.workspaceId,
          status: filter.statuses ? { in: filter.statuses } : { not: 'DELETED' },
          ...(filter.platform ? { platform: filter.platform } : {}),
          ...(filter.accountId ? { socialAccountId: filter.accountId } : {}),
          AND: [
            filter.order === 'schedule' || filter.from || filter.to
              ? { scheduledAt: { not: null, gte: filter.from, lt: filter.to } }
              : {},
            after ? afterCursor(filter.order, after) : {},
          ],
        },
        orderBy:
          filter.order === 'schedule'
            ? [{ scheduledAt: 'asc' }, { id: 'asc' }]
            : [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: filter.limit + 1,
        select: {
          id: true,
          postId: true,
          platform: true,
          status: true,
          version: true,
          text: true,
          scheduledAt: true,
          scheduledTimezone: true,
          publishedAt: true,
          externalUrl: true,
          failureCode: true,
          isDryRun: true,
          updatedAt: true,
          socialAccount: { select: { id: true, name: true, handle: true, type: true } },
        },
      });
      const page = rows.slice(0, filter.limit);
      const last = page.at(-1);
      const position = last ? (filter.order === 'schedule' ? last.scheduledAt : last.updatedAt) : null;
      return {
        items: page.map(({ text, socialAccount, ...row }) => ({
          ...row,
          preview: previewOf(text),
          account: socialAccount,
        })),
        nextCursor:
          rows.length > filter.limit && last && position
            ? encodeCursor({ at: position.toISOString(), id: last.id })
            : null,
      };
    });
  }
}
